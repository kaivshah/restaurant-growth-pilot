"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { LEAD_SKIP_REASONS } from "@/lib/leads/score";
import { requireRestaurant } from "@/lib/restaurant";

async function ownLead(id: string) {
  const restaurant = await requireRestaurant();
  return db.lead.findFirst({ where: { id, restaurantId: restaurant.id } });
}

function done() {
  revalidatePath("/leads");
  revalidatePath("/inbox");
}

/** Keep a business out of pitches. Its waiting pitch leaves the inbox. */
export async function excludeLead(formData: FormData) {
  const lead = await ownLead(String(formData.get("id") ?? ""));
  const reason = String(formData.get("reason") ?? "");
  if (!lead || !LEAD_SKIP_REASONS.includes(reason)) return;
  await db.lead.update({ where: { id: lead.id }, data: { status: "EXCLUDED", excludeReason: reason } });
  await db.draft.updateMany({ where: { leadId: lead.id, status: "PENDING" }, data: { status: "SKIPPED", skipReason: reason, decidedAt: new Date() } });
  done();
}

/** Put an excluded business back. It can be pitched on the next scan. */
export async function includeLead(formData: FormData) {
  const lead = await ownLead(String(formData.get("id") ?? ""));
  if (!lead) return;
  const pitched = await db.draft.findFirst({ where: { leadId: lead.id, status: "APPROVED" } });
  await db.lead.update({ where: { id: lead.id }, data: { status: pitched ? "APPROVED" : "NEW", excludeReason: null } });
  done();
}

const contactSchema = z.object({
  name: z.string().trim().max(80).optional(),
  role: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email(),
});

export async function addLeadContact(formData: FormData) {
  const lead = await ownLead(String(formData.get("id") ?? ""));
  const parsed = contactSchema.safeParse({
    name: String(formData.get("name") ?? "") || undefined,
    role: String(formData.get("role") ?? "") || undefined,
    email: String(formData.get("email") ?? ""),
  });
  if (!lead || !parsed.success) return;
  const { name, role, email } = parsed.data;
  await db.contact.upsert({
    where: { leadId_email: { leadId: lead.id, email } },
    create: { leadId: lead.id, email, name: name ?? null, role: role ?? null, source: "owner" },
    update: { name: name ?? null, role: role ?? null, source: "owner" },
  });
  done();
}
