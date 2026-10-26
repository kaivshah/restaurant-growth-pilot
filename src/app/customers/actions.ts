"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { joinList } from "@/lib/customers";
import { db } from "@/lib/db";
import { kickJobs } from "@/lib/drafts";
import { suppress } from "@/lib/outreach";
import { requireRestaurant } from "@/lib/restaurant";

export type AddState = { ok?: string; error?: string } | undefined;

/** The owner adds someone who agreed (at the counter, on a catering order…). */
export async function addCustomer(_prev: AddState, formData: FormData): Promise<AddState> {
  const restaurant = await requireRestaurant();
  const res = await joinList(restaurant.id, {
    email: String(formData.get("email") ?? ""),
    firstName: String(formData.get("firstName") ?? ""),
    consent: formData.get("consent") === "on",
    source: "owner",
  });
  if (!res.ok) return { error: res.error };
  after(() => kickJobs());
  revalidatePath("/customers");
  if (!res.welcome) return { ok: "Added to your list." };
  return { ok: `Added. Welcome code ${res.welcome.code}${res.welcome.emailed ? " is on its way by email" : " (connect Gmail to email it)"}.` };
}

export async function removeCustomer(formData: FormData) {
  const restaurant = await requireRestaurant();
  const customer = await db.customer.findFirst({ where: { id: String(formData.get("id") ?? ""), restaurantId: restaurant.id } });
  if (!customer) return;
  await suppress(restaurant.id, customer.email, "unsubscribed");
  revalidatePath("/customers");
}

export async function setCustomerCap(formData: FormData) {
  const restaurant = await requireRestaurant();
  const cap = z.coerce.number().int().min(1).max(400).safeParse(formData.get("cap"));
  if (!cap.success) return;
  await db.restaurant.update({ where: { id: restaurant.id }, data: { customerDailyCap: cap.data } });
  revalidatePath("/customers");
}
