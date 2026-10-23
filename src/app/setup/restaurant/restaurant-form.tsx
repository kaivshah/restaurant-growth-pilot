"use client";

import { useActionState, useState } from "react";
import { Button, Card, ChoiceCard, Field, Notice, inputClass } from "@/components/ui";
import { saveRestaurant } from "../actions";

type Defaults = {
  name: string;
  kind: "FRANCHISE" | "INDEPENDENT";
  brand: string;
  address: string;
  radiusMiles: number;
  minCateringOrder: number;
  openingHours: string;
};

const RING: Record<number, string> = { 1: "size-[120px]", 3: "size-[200px]", 5: "size-[260px]" };
const LEAD_TYPES = ["Offices", "Coworking spaces", "Schools & PTAs", "Clinics", "Gyms & teams", "Event venues"];

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-sm font-semibold text-danger">{message}</p> : null;
}

export function RestaurantForm({ defaults }: { defaults: Defaults }) {
  const [state, action, pending] = useActionState(saveRestaurant, undefined);
  const [kind, setKind] = useState(defaults.kind);
  const [radius, setRadius] = useState(defaults.radiusMiles);
  const errors = state?.fieldErrors ?? {};

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card className="p-6 sm:p-8">
        <form action={action} className="flex flex-col gap-6">
          <Field label="Restaurant name" htmlFor="name">
            <input id="name" name="name" defaultValue={defaults.name} placeholder="e.g. Subway #32105" className={inputClass} required />
            <FieldError message={errors.name} />
          </Field>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-3 text-sm font-bold">What kind of restaurant is it?</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <ChoiceCard id="kind-fr" type="radio" name="kind" value="FRANCHISE" checked={kind === "FRANCHISE"} onChange={() => setKind("FRANCHISE")}>
                <span className="font-bold">Franchise outlet</span>
                <span className="text-sm text-muted">We follow your brand&apos;s rules for menus, prices and promotions</span>
              </ChoiceCard>
              <ChoiceCard id="kind-ind" type="radio" name="kind" value="INDEPENDENT" checked={kind === "INDEPENDENT"} onChange={() => setKind("INDEPENDENT")}>
                <span className="font-bold">Independent restaurant</span>
                <span className="text-sm text-muted">You set your own menu, prices and offers</span>
              </ChoiceCard>
            </div>
            {kind === "FRANCHISE" && (
              <Field label="Franchise brand" htmlFor="brand">
                <input id="brand" name="brand" defaultValue={defaults.brand} placeholder="e.g. Subway" className={`${inputClass} max-w-xs`} />
              </Field>
            )}
          </fieldset>

          <Field label="Outlet address" htmlFor="address" hint="Street address, city and ZIP code.">
            <input id="address" name="address" defaultValue={defaults.address} placeholder="Street address, San Diego, CA 92129" className={inputClass} autoComplete="street-address" required />
            <FieldError message={errors.address} />
          </Field>

          <div className="grid gap-6 sm:grid-cols-2">
            <fieldset>
              <legend className="mb-2 text-sm font-bold">Catering delivery radius</legend>
              <div className="flex gap-2">
                {[1, 3, 5].map((mi) => (
                  <label
                    key={mi}
                    htmlFor={`r${mi}`}
                    className="flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-field border border-field bg-surface font-semibold has-[:checked]:border-2 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:checked]:text-primary-ink"
                  >
                    <input id={`r${mi}`} type="radio" name="radiusMiles" value={mi} checked={radius === mi} onChange={() => setRadius(mi)} className="accent-primary" />
                    {mi} mi
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Smallest catering order" htmlFor="minCateringOrder">
              <div className="flex items-center gap-3">
                <input id="minCateringOrder" name="minCateringOrder" type="number" min={1} max={500} defaultValue={defaults.minCateringOrder} className={`${inputClass} max-w-28`} />
                <span className="text-muted">people</span>
              </div>
              <FieldError message={errors.minCateringOrder} />
            </Field>
          </div>

          <Field label="Opening hours" htmlFor="openingHours" hint="We never suggest offers for hours you're closed.">
            <input id="openingHours" name="openingHours" defaultValue={defaults.openingHours} placeholder="e.g. Mon–Sun, 9:00 am – 10:00 pm" className={inputClass} />
          </Field>

          {state?.error && <Notice tone="danger">{state.error}</Notice>}

          <div className="flex justify-end border-t border-sand pt-6">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save and continue"}
            </Button>
          </div>
        </form>
      </Card>

      <aside className="flex flex-col gap-4">
        <Card className="overflow-hidden">
          <div
            className="relative h-[280px] bg-[#eef3ec]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg,transparent 0 38px,#dce6da 38px 40px),repeating-linear-gradient(90deg,transparent 0 38px,#dce6da 38px 40px)",
            }}
            aria-hidden="true"
          >
            <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-primary bg-primary/10 ${RING[radius]}`} />
            <div className="absolute top-1/2 left-1/2 size-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-primary shadow" />
            <div className="absolute bottom-4 left-4 rounded-full bg-surface px-3 py-1.5 text-[13px] font-bold">{radius} mi search area</div>
          </div>
          <div className="flex flex-col gap-3 p-6">
            <p className="font-bold">What we look for nearby</p>
            <div className="flex flex-wrap gap-2 text-sm">
              {LEAD_TYPES.map((t) => (
                <span key={t} className="rounded-full bg-primary-soft px-3 py-1.5 text-primary-ink">
                  {t}
                </span>
              ))}
            </div>
            <p className="text-sm text-muted">Your first leads appear in the Approval Inbox when setup is done.</p>
          </div>
        </Card>
        {kind === "FRANCHISE" && (
          <Notice title="Playing it safe for franchises">
            Until you confirm your brand&apos;s rules in step 4, drafts use the brand&apos;s catering menu and prices, and offer free extras instead of price cuts.
          </Notice>
        )}
      </aside>
    </div>
  );
}
