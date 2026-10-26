"use server";

import { after } from "next/server";
import { joinList } from "@/lib/customers";
import { db } from "@/lib/db";
import { kickJobs } from "@/lib/drafts";

export type JoinState =
  | { done: true; firstName: string | null; welcome: { title: string; code: string; until: string; emailed: boolean } | null; already?: boolean }
  | { done?: false; error?: string }
  | undefined;

export async function join(_prev: JoinState, formData: FormData): Promise<JoinState> {
  // Bots fill every field; people never see this one.
  if (String(formData.get("website") ?? "")) return { done: true, firstName: null, welcome: null };
  const restaurant = await db.restaurant.findUnique({ where: { joinSlug: String(formData.get("slug") ?? "") }, select: { id: true } });
  if (!restaurant) return { error: "This sign-up link isn't working. Please ask at the counter." };
  const res = await joinList(restaurant.id, {
    email: String(formData.get("email") ?? ""),
    firstName: String(formData.get("firstName") ?? ""),
    consent: formData.get("consent") === "on",
    source: "qr",
  });
  if (!res.ok) return { error: res.error };
  // Send the welcome email now rather than on the next worker pass.
  after(() => kickJobs());
  // Someone typing another person's email shouldn't see that person's code.
  if (res.welcome?.existing) return { done: true, firstName: null, welcome: null, already: true };
  return {
    done: true,
    firstName: res.firstName,
    welcome: res.welcome
      ? { title: res.welcome.title, code: res.welcome.code, until: res.welcome.validUntil.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Los_Angeles" }), emailed: res.welcome.emailed }
      : null,
  };
}
