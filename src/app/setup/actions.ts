"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { REPLAN_DELAY_MS, enqueueDraftJob, kickJobs, scheduleReplan } from "@/lib/drafts";
import { GROUP_NAMES, GROUP_TYPES, MAX_EXTRA_FILES, MAX_WEEKS, MIN_WEEKS, REPORT_LABELS, type UploadGroup, completeWeeks, expandUpload, groupOf, parseReportFile, weeksOf } from "@/lib/reports";
import type { ParsedReport } from "@/lib/reports";
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
    // A WISR export comes as one zip of six reports: each is read on its own.
    const parts = expandUpload(file.name, await file.arrayBuffer());
    if ("error" in parts) {
      results.push({ fileName: file.name, ok: false, message: parts.error });
      continue;
    }
    for (const part of parts) results.push(await saveReport(restaurant.id, parts.length > 1 ? `${file.name} › ${part.name}` : part.name, part.data));
  }
  if (results.some((r) => r.ok)) await replanAfterReportChange(restaurant.id);
  revalidatePath("/setup/reports");
  return { results };
}

/** Reads one report and stores it; the same report for the same week replaces the earlier copy. */
async function saveReport(restaurantId: string, fileName: string, data: ArrayBuffer): Promise<UploadResult> {
  const parsed = await parseReportFile(fileName.split(" › ").pop()!, data);
  if (!parsed.ok) return { fileName, ok: false, message: parsed.message };
  return storeReport(restaurantId, fileName, parsed.report);
}

async function storeReport(restaurantId: string, fileName: string, report: ParsedReport): Promise<UploadResult> {
  const periodStart = report.period ? new Date(report.period.start) : null;
  const periodEnd = report.period ? new Date(report.period.end) : null;
  // A new copy replaces the old one: the same week of a report, or the same other file.
  await db.reportUpload.deleteMany({
    where: report.type === "extraTable" ? { restaurantId, reportType: report.type, fileName } : { restaurantId, reportType: report.type, periodEnd },
  });
  await db.reportUpload.create({
    data: {
      restaurantId,
      fileName,
      reportType: report.type,
      storeNumber: report.storeNumber,
      periodStart,
      periodEnd,
      data: JSON.parse(JSON.stringify(report)),
    },
  });
  return { fileName, ok: true, message: `Read as ${REPORT_LABELS[report.type]}` };
}

/**
 * After reports change, once setup is done and 4 weeks of each are in, the
 * plan runs again by itself (grouped: see scheduleReplan). The worker picks
 * it up; without one, this server starts it when the wait is over.
 */
async function replanAfterReportChange(restaurantId: string) {
  const restaurant = await db.restaurant.findUnique({ where: { id: restaurantId }, select: { setupCompletedAt: true } });
  if (!restaurant?.setupCompletedAt) return;
  const uploads = await db.reportUpload.findMany({ where: { restaurantId }, select: { reportType: true, periodStart: true, periodEnd: true, fileName: true, status: true } });
  if (completeWeeks(weeksOf("dayPart", uploads)).length < MIN_WEEKS || completeWeeks(weeksOf("wisr", uploads)).length < MIN_WEEKS) return;
  await scheduleReplan(restaurantId);
  after(() => {
    setTimeout(() => kickJobs(), REPLAN_DELAY_MS + 2_000).unref?.();
  });
}

/**
 * One week's upload into a section (Day Part, WISR or Cash In Week): a file
 * of the wrong kind is refused, and a ninth week is refused (eight is the
 * most the AI reads). Uploading a week that's already there replaces it.
 */
export async function uploadWeek(_prev: UploadState, formData: FormData): Promise<UploadState> {
  const restaurant = await requireRestaurant();
  const group = String(formData.get("group") ?? "") as UploadGroup;
  if (!(group in GROUP_TYPES)) return { results: [{ fileName: "", ok: false, message: "Unknown section." }] };
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { results: [{ fileName: "", ok: false, message: "Choose a file." }] };

  const existing = await db.reportUpload.findMany({ where: { restaurantId: restaurant.id, reportType: { in: GROUP_TYPES[group] } }, select: { periodEnd: true } });
  const weeks = new Set(existing.flatMap((u) => (u.periodEnd ? [u.periodEnd.toISOString().slice(0, 10)] : [])));
  const results: UploadResult[] = [];
  for (const file of files.slice(0, MAX_FILES)) {
    if (file.size > MAX_BYTES) {
      results.push({ fileName: file.name, ok: false, message: "This file is larger than 5 MB." });
      continue;
    }
    const parts = expandUpload(file.name, await file.arrayBuffer());
    if ("error" in parts) {
      results.push({ fileName: file.name, ok: false, message: parts.error });
      continue;
    }
    for (const part of parts) {
      const name = parts.length > 1 ? `${file.name} › ${part.name}` : part.name;
      const parsed = await parseReportFile(part.name, part.data);
      if (!parsed.ok) {
        results.push({ fileName: name, ok: false, message: parsed.message });
        continue;
      }
      const type = parsed.report.type;
      if (type === "extraTable") {
        // Any other export is optional, wherever it was uploaded (e.g. an extra file inside a WISR zip).
        const count = await db.reportUpload.count({ where: { restaurantId: restaurant.id, reportType: { in: GROUP_TYPES.other }, NOT: { fileName: name } } });
        if (count >= MAX_EXTRA_FILES) {
          results.push({ fileName: name, ok: false, message: `You already have ${MAX_EXTRA_FILES} optional files. Remove one before adding another.` });
          continue;
        }
        results.push(await storeReport(restaurant.id, name, parsed.report));
        continue;
      }
      if (groupOf(type) !== group) {
        results.push({ fileName: name, ok: false, message: `This is a ${REPORT_LABELS[type]} file. Upload it under ${GROUP_NAMES[groupOf(type)]}.` });
        continue;
      }
      const week = parsed.report.period?.end ?? null;
      const cap = group === "other" ? MAX_EXTRA_FILES : MAX_WEEKS;
      if (week && !weeks.has(week) && weeks.size >= cap) {
        results.push({ fileName: name, ok: false, message: `You already have ${cap} weeks of ${GROUP_NAMES[group]}. Remove one before adding another.` });
        continue;
      }
      if (week) weeks.add(week);
      results.push(await storeReport(restaurant.id, name, parsed.report));
    }
  }
  if (results.some((r) => r.ok)) await replanAfterReportChange(restaurant.id);
  revalidatePath("/setup/reports");
  return { results };
}

/** Removes one week of a section (for WISR, all six reports of that week). */
export async function removeWeek(formData: FormData) {
  const restaurant = await requireRestaurant();
  const group = String(formData.get("group") ?? "") as UploadGroup;
  const end = String(formData.get("end") ?? "");
  if (!(group in GROUP_TYPES) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return;
  const { count } = await db.reportUpload.deleteMany({ where: { restaurantId: restaurant.id, reportType: { in: GROUP_TYPES[group] }, periodEnd: new Date(end) } });
  if (count) await replanAfterReportChange(restaurant.id);
  revalidatePath("/setup/reports");
}

export async function removeReport(formData: FormData) {
  const restaurant = await requireRestaurant();
  const id = String(formData.get("id") ?? "");
  const { count } = await db.reportUpload.deleteMany({ where: { id, restaurantId: restaurant.id } });
  if (count) await replanAfterReportChange(restaurant.id);
  revalidatePath("/setup/reports");
}

/** The reports whose numbers the confirm table shows for each week. */
const CONFIRM_TYPES: ReportType[] = ["wisrSales", "wisrUnits", "wisrAdjCogs", "dayPart"];

export async function confirmNumbers(formData: FormData) {
  const restaurant = await requireRestaurant();
  const shown = formData.getAll("shownWeek").map(String).filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w));
  const ok = new Set(formData.getAll("okWeek").map(String));
  if (!shown.length) redirect("/setup/reports");
  // Four weeks of each export are needed before the numbers are used.
  const uploads = await db.reportUpload.findMany({ where: { restaurantId: restaurant.id }, select: { reportType: true, periodStart: true, periodEnd: true, fileName: true, status: true } });
  if (completeWeeks(weeksOf("dayPart", uploads)).length < MIN_WEEKS || completeWeeks(weeksOf("wisr", uploads)).length < MIN_WEEKS) redirect("/setup/reports?need=1");

  // Each week shown: its summary reports are confirmed, or marked wrong (left out until uploaded again).
  const flagged = shown.filter((w) => !ok.has(w));
  for (const week of shown) {
    await db.reportUpload.updateMany({
      where: { restaurantId: restaurant.id, reportType: { in: CONFIRM_TYPES }, periodEnd: new Date(week) },
      data: { status: flagged.includes(week) ? "FLAGGED" : "CONFIRMED" },
    });
  }
  revalidatePath("/setup/reports");
  if (flagged.length === 0 && restaurant.setupCompletedAt) {
    // Setup is already done, so new numbers mean a fresh plan.
    await enqueueDraftJob(restaurant.id, "DAILY");
    after(() => kickJobs());
  }
  redirect(flagged.length > 0 ? "/setup/reports?flagged=1" : restaurant.setupCompletedAt ? "/setup/reports?saved=1" : "/setup/menu");
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
  // Setup finished or rules changed: scan the area (a scan from the last day is reused),
  // and the day's plan (deals and the top catering picks) follows the scan.
  await enqueueDraftJob(restaurant.id, "LEADS");
  after(() => kickJobs());
  redirect(restaurant.setupCompletedAt ? "/setup/rules?saved=1" : "/inbox");
}
