"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button, Card, Notice } from "@/components/ui";
import { saveRules } from "../actions";

type Defaults = {
  promoApproval: "YES" | "NO" | "UNSURE";
  maxDiscountPct: number;
  allowFreeExtra: boolean;
  allowFreeDelivery: boolean;
  allowPercentOff: boolean;
  allowBogo: boolean;
  useBrandCateringMenu: boolean;
};

const APPROVAL = [
  { value: "YES", label: "Yes" },
  { value: "NO", label: "No, approval needed" },
  { value: "UNSURE", label: "Not sure yet" },
] as const;

const OFFER_TYPES = [
  { name: "allowFreeExtra", label: "Free extra (cookie, chips, drink)" },
  { name: "allowFreeDelivery", label: "Free catering delivery" },
  { name: "allowPercentOff", label: "Percentage off, within the limit" },
  { name: "allowBogo", label: "Buy one, get one" },
] as const;

const optionClass =
  "flex min-h-[52px] cursor-pointer items-center gap-3 rounded-field border border-field bg-surface px-4 has-[:checked]:border-2 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:checked]:font-bold";

export function RulesForm({ defaults, discountPct }: { defaults: Defaults; discountPct: number | null }) {
  const [state, action, pending] = useActionState(saveRules, undefined);
  const [approval, setApproval] = useState(defaults.promoApproval);
  const [maxDiscount, setMaxDiscount] = useState(defaults.maxDiscountPct);

  return (
    <Card className="p-6 sm:p-8">
      <form action={action} className="flex flex-col gap-8">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-bold">Can you run local promotions without brand approval?</legend>
          <p className="text-sm text-muted">Check your franchise agreement, or ask your franchise business consultant.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {APPROVAL.map((a) => (
              <label key={a.value} htmlFor={`ap-${a.value}`} className={optionClass}>
                <input
                  id={`ap-${a.value}`}
                  type="radio"
                  name="promoApproval"
                  value={a.value}
                  checked={approval === a.value}
                  onChange={() => setApproval(a.value)}
                  className="size-[18px] accent-primary"
                />
                {a.label}
              </label>
            ))}
          </div>
          {approval !== "YES" && (
            <Notice title="Playing it safe.">
              Drafts use the brand&apos;s catering menu and prices, offer free extras instead of price cuts, and say &ldquo;independently owned and operated&rdquo;.
            </Notice>
          )}
        </fieldset>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="maxDiscountPct" className="font-bold">
              Largest discount allowed
            </label>
            <span className="rounded-full bg-primary-soft px-3.5 py-1 text-lg font-extrabold text-primary-ink tabular-nums">
              {maxDiscount === 0 ? "None" : `${maxDiscount}%`}
            </span>
          </div>
          <input
            id="maxDiscountPct"
            name="maxDiscountPct"
            type="range"
            min={0}
            max={30}
            step={5}
            value={maxDiscount}
            onChange={(e) => setMaxDiscount(Number(e.target.value))}
            className="h-7 w-full accent-primary"
          />
          {discountPct !== null && (
            <p className="text-sm text-muted">
              You already give away {discountPct}% of sales in discounts and free items, so we suggest small, targeted offers.
            </p>
          )}
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 font-bold">Offers we may suggest</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {OFFER_TYPES.map((o) => (
              <label key={o.name} htmlFor={o.name} className={optionClass}>
                <input id={o.name} name={o.name} type="checkbox" defaultChecked={defaults[o.name]} className="size-5 accent-primary" />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label htmlFor="useBrandCateringMenu" className="grid cursor-pointer grid-cols-[22px_minmax(0,1fr)] gap-3 rounded-2xl bg-ground px-5 py-4">
          <input id="useBrandCateringMenu" name="useBrandCateringMenu" type="checkbox" defaultChecked={defaults.useBrandCateringMenu} className="mt-0.5 size-5 accent-primary" />
          <span className="flex flex-col gap-0.5">
            <span className="font-bold">Use the brand&apos;s catering menu and prices</span>
            <span className="text-sm text-muted">We never invent items or prices.</span>
          </span>
        </label>

        <div className="flex flex-col gap-2 border-t border-sand pt-6">
          <p className="font-bold">Send from your own email</p>
          <p className="text-sm text-muted">
            Connecting Gmail or Outlook comes with catering outreach in a later update. Nothing will ever be sent until you approve it.
          </p>
        </div>

        {state?.error && <Notice tone="danger">{state.error}</Notice>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-sand pt-6">
          <Link href="/setup/menu" className="inline-flex min-h-[52px] items-center px-2 font-bold text-primary">
            Back
          </Link>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Finish setup"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
