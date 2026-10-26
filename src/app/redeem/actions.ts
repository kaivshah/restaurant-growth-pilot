"use server";

import { revalidatePath } from "next/cache";
import { type CodeCheck, checkCode, redeemCode } from "@/lib/customers";
import { requireRestaurant } from "@/lib/restaurant";

export type RedeemView =
  | { state: CodeCheck["state"]; code: string; offer?: string; firstName?: string | null; validUntil?: string; redeemedAt?: string; justUsed?: boolean }
  | undefined;

const show = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

function view(c: CodeCheck, justUsed = false): RedeemView {
  if (!("offer" in c)) return { state: c.state, code: c.code };
  return { ...c, validUntil: show(c.validUntil), redeemedAt: c.redeemedAt ? show(c.redeemedAt) : undefined, justUsed };
}

/** Step 1 at the counter: look the code up. Step 2: mark it used. */
export async function redeemAction(_prev: RedeemView, formData: FormData): Promise<RedeemView> {
  const restaurant = await requireRestaurant();
  const code = String(formData.get("code") ?? "");
  if (formData.get("use") !== "1") return view(await checkCode(restaurant.id, code));
  const res = await redeemCode(restaurant.id, code);
  revalidatePath("/customers");
  return view(res, res.state === "ok");
}
