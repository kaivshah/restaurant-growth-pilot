import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireRestaurant } from "@/lib/restaurant";
import { AppShell } from "../inbox/shell";
import { RedeemForm } from "./redeem-form";

/** At the till: type the customer's code, check it, mark it used. Works on a phone. */
export default async function RedeemPage() {
  const restaurant = await requireRestaurant();
  if (!restaurant.setupCompletedAt) redirect("/setup/reports");
  const [pending, today] = await Promise.all([
    db.draft.count({ where: { restaurantId: restaurant.id, status: "PENDING" } }),
    db.offerCode.count({ where: { restaurantId: restaurant.id, redeemedAt: { gte: new Date(Date.now() - 86_400_000) } } }),
  ]);
  return (
    <AppShell pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      <div className="flex flex-col gap-1">
        <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">Redeem a code</h1>
        <p className="text-lg text-ink-2">Type the code from the customer&apos;s email. {today} used in the last 24 hours.</p>
      </div>
      <div className="w-full max-w-md">
        <RedeemForm />
      </div>
    </AppShell>
  );
}
