import { Card } from "@/components/ui";
import { db } from "@/lib/db";
import { requireRestaurant } from "@/lib/restaurant";
import { RulesForm } from "./rules-form";

export default async function RulesStep() {
  const restaurant = await requireRestaurant();
  const adjCogs = await db.reportUpload.findFirst({
    where: { restaurantId: restaurant.id, reportType: "wisrAdjCogs" },
    orderBy: { periodEnd: "desc" },
  });
  const discountPct = (adjCogs?.data as { discountPctOfSales?: number } | null)?.discountPctOfSales ?? null;

  const ticks = ["Your name and the outlet's address", "A one-click unsubscribe link", "“Independently owned and operated”", "No brand logos for now"];

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-extrabold leading-tight tracking-tight">Set the rules every draft follows</h1>
        <p className="max-w-[62ch] text-muted">
          We check each catering pitch and customer offer against these rules before it reaches your inbox. You can change them any time.
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <RulesForm
          discountPct={discountPct}
          defaults={{
            promoApproval: restaurant.promoApproval,
            maxDiscountPct: restaurant.maxDiscountPct,
            allowFreeExtra: restaurant.allowFreeExtra,
            allowFreeDelivery: restaurant.allowFreeDelivery,
            allowPercentOff: restaurant.allowPercentOff,
            allowBogo: restaurant.allowBogo,
            useBrandCateringMenu: restaurant.useBrandCateringMenu,
          }}
        />
        <aside className="flex flex-col gap-4">
          <Card className="flex flex-col gap-3 p-6">
            <h2 className="text-lg font-bold">Every email includes</h2>
            <ul className="flex flex-col gap-2.5 text-[15px]">
              {ticks.map((t) => (
                <li key={t} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5">
                  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                    <circle cx="10" cy="10" r="9" fill="#E4F1E8" />
                    <path d="M6 10.5l2.6 2.6L14 7.6" stroke="#2E7D4F" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {t}
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted">This keeps you within US email law (CAN-SPAM) and typical franchise rules.</p>
          </Card>
          <div className="rounded-card bg-primary-soft px-6 py-5 text-[15px] text-primary-ink">
            <p className="mb-1 font-bold">What happens next</p>
            We prepare your first catering drafts and offer ideas. They wait in your Approval Inbox until you review them.
          </div>
        </aside>
      </div>
    </>
  );
}
