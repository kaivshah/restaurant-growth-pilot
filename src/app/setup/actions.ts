"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { enqueueDraftJob, kickJobs } from "@/lib/drafts";
import { REPORT_LABELS, parseReportFile } from "@/lib/reports";
import type { ReportType } from "@/lib/reports";
import { getRestaurant, requireRestaurant, requireUserId } from "@/lib/restaurant";

export type FormState = { error?: string; fieldErrors?: Record<string, string> } | undefined;

const restaurantSchema = z.object({
  name: z.string().trim().min(1, "Enter your restaurant's name").max(120),
  kind: z.enum(["FRANCHISE", "INDEPENDENT"]),
  brand: z.string().trim().max(80).optional(),
  address: z.string().trim().min(5, "Enter the outlet's street address").max(300),
  radiusMiles: z.coerce.number().int().refine((n) => [1, 3, 5].includes(n), "Pick 1, 3 or 5 miles"),
  minCateringOrder: z.coerce.number().int().min(1, "At least 1 person").max(500, "500 people at most"),
  openingHours: z.string().trim().max(200).optional(),
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0]);
    out[key] ??= issue.message;
  }
  return out;
}

export async function saveRestaurant(_prev: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const parsed = restaurantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };
  const { address, ...fields } = parsed.data;
  const data = {
    ...fields,
    brand: fields.kind === "FRANCHISE" ? fields.brand || null : null,
    openingHours: fields.openingHours || null,
  };

  const existing = await getRestaurant(userId);
  if (existing?.setupCompletedAt) {
    const moved = existing.outlets[0]?.address !== address || existing.radiusMiles !== data.radiusMiles;
    await db.restaurant.update({ where: { id: existing.id }, data });
    if (existing.outlets[0]) await db.outlet.update({ where: { id: existing.outlets[0].id }, data: { address } });
    // A new address or radius means a new area to search (Google and event APIs only, no AI).
    if (moved) {
      await enqueueDraftJob(existing.id, "LEADS", true);
      after(() => kickJobs());
    }
    redirect("/setup/restaurant?saved=1");
  }
  if (existing) {
    await db.restaurant.update({ where: { id: existing.id }, data });
    const outlet = existing.outlets[0];
    if (outlet) await db.outlet.update({ where: { id: outlet.id }, data: { address } });
    else await db.outlet.create({ data: { restaurantId: existing.id, address } });
  } else {
    await db.restaurant.create({ data: { ...data, ownerId: userId, outlets: { create: { address } } } });
  }
  redirect("/setup/reports");
}

export type UploadResult = { fileName: string; ok: boolean; message: string };
export type UploadState = { results: UploadResult[] } | undefined;

const MAX_FILES = 20;
const MAX_BYTES = 5 * 1024 * 1024;

export async function uploadReports(_prev: UploadState, formData: FormData): Promise<UploadState> {
  const restaurant = await requireRestaurant();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { results: [{ fileName: "", ok: false, message: "Choose at least one file." }] };
  if (files.length > MAX_FILES) {
    return { results: [{ fileName: "", ok: false, message: `Upload up to ${MAX_FILES} files at a time.` }] };
  }

  const results: UploadResult[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      results.push({ fileName: file.name, ok: false, message: "This file is larger than 5 MB." });
      continue;
    }
    const parsed = await parseReportFile(file.name, await file.arrayBuffer());
    if (!parsed.ok) {
      results.push({ fileName: file.name, ok: false, message: parsed.message });
      continue;
    }
    const { report } = parsed;
    const periodStart = report.period ? new Date(report.period.start) : null;
    const periodEnd = report.period ? new Date(report.period.end) : null;
    // Uploading the same report for the same week replaces the earlier copy.
    await db.reportUpload.deleteMany({
      where: { restaurantId: restaurant.id, reportType: report.type, periodEnd },
    });
    await db.reportUpload.create({
      data: {
        restaurantId: restaurant.id,
        fileName: file.name,
        reportType: report.type,
        storeNumber: report.storeNumber,
        periodStart,
        periodEnd,
        data: JSON.parse(JSON.stringify(report)),
      },
    });
    results.push({ fileName: file.name, ok: true, message: `Read as ${REPORT_LABELS[report.type]}` });
  }
  revalidatePath("/setup/reports");
  return { results };
}

export async function removeReport(formData: FormData) {
  const restaurant = await requireRestaurant();
  const id = String(formData.get("id") ?? "");
  await db.reportUpload.deleteMany({ where: { id, restaurantId: restaurant.id } });
  revalidatePath("/setup/reports");
}

/** Which report each confirm-screen number comes from. */
const NUMBER_SOURCES: Record<string, ReportType> = {
  netSales: "wisrSales",
  cateringSales: "wisrSales",
  customers: "wisrUnits",
  averageTicket: "wisrUnits",
  drinkPct: "wisrUnits",
  discounts: "wisrAdjCogs",
};

export async function confirmNumbers(formData: FormData) {
  const restaurant = await requireRestaurant();
  const periodEnd = String(formData.get("periodEnd") ?? "");
  const shown = formData.getAll("shown").map(String);
  const ticked = new Set(formData.getAll("ok").map(String));
  const flaggedTypes = new Set(shown.filter((k) => !ticked.has(k)).map((k) => NUMBER_SOURCES[k]).filter(Boolean));
  const weekTypes = new Set(shown.map((k) => NUMBER_SOURCES[k]).filter(Boolean));

  const date = new Date(periodEnd);
  if (Number.isNaN(date.getTime())) redirect("/setup/reports");

  for (const type of weekTypes) {
    await db.reportUpload.updateMany({
      where: { restaurantId: restaurant.id, reportType: type, periodEnd: date },
      data: { status: flaggedTypes.has(type) ? "FLAGGED" : "CONFIRMED" },
    });
  }
  revalidatePath("/setup/reports");
  if (flaggedTypes.size === 0 && restaurant.setupCompletedAt) {
    // Setup is already done, so new numbers mean fresh offer ideas.
    await enqueueDraftJob(restaurant.id);
    after(() => kickJobs());
  }
  redirect(flaggedTypes.size > 0 ? "/setup/reports?flagged=1" : restaurant.setupCompletedAt ? "/setup/reports?saved=1" : "/setup/menu");
}

const rulesSchema = z.object({
  promoApproval: z.enum(["YES", "NO", "UNSURE"]),
  maxDiscountPct: z.coerce.number().int().min(0).max(30),
});

export async function saveRules(_prev: FormState, formData: FormData): Promise<FormState> {
  const restaurant = await requireRestaurant();
  const parsed = rulesSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Choose an answer about brand approval." };
  const on = (name: string) => formData.get(name) === "on";
  await db.restaurant.update({
    where: { id: restaurant.id },
    data: {
      ...parsed.data,
      allowFreeExtra: on("allowFreeExtra"),
      allowFreeDelivery: on("allowFreeDelivery"),
      allowPercentOff: on("allowPercentOff"),
      allowBogo: on("allowBogo"),
      useBrandCateringMenu: on("useBrandCateringMenu"),
      setupCompletedAt: restaurant.setupCompletedAt ?? new Date(),
    },
  });
  // Rules may have changed which offers are allowed; rebuild drafts in the background.
  // The area scan reuses a scan from the last day, so this only re-picks the pitches.
  await enqueueDraftJob(restaurant.id);
  await enqueueDraftJob(restaurant.id, "LEADS");
  after(() => kickJobs());
  redirect(restaurant.setupCompletedAt ? "/setup/rules?saved=1" : "/inbox");
}
