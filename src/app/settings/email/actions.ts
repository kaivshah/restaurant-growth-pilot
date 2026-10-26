"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { disconnect } from "@/lib/gmail";
import { suppress } from "@/lib/outreach";
import { requireRestaurant } from "@/lib/restaurant";

export async function disconnectGmail() {
  const restaurant = await requireRestaurant();
  await disconnect(restaurant.id);
  revalidatePath("/settings/email");
}

export async function setDailyCap(formData: FormData) {
  const restaurant = await requireRestaurant();
  const cap = z.coerce.number().int().min(1).max(100).safeParse(formData.get("cap"));
  if (!cap.success) return;
  await db.restaurant.update({ where: { id: restaurant.id }, data: { sendDailyCap: cap.data } });
  revalidatePath("/settings/email");
}

/** "Never email this address": the owner's own do-not-contact list. */
export async function blockAddress(formData: FormData) {
  const restaurant = await requireRestaurant();
  const email = z.string().trim().toLowerCase().email().safeParse(formData.get("email"));
  if (!email.success) return;
  await suppress(restaurant.id, email.data, "owner");
  revalidatePath("/settings/email");
}

export async function unblockAddress(formData: FormData) {
  const restaurant = await requireRestaurant();
  const id = String(formData.get("id") ?? "");
  // Only the owner's own entries can be removed; unsubscribes are permanent.
  await db.suppression.deleteMany({ where: { id, restaurantId: restaurant.id, reason: "owner" } });
  revalidatePath("/settings/email");
}
