import type { HourBar, Insights } from "@/lib/insights";

/**
 * Turns insights into offer ideas, applying the owner's brand rules.
 * Every number in an offer's text comes from Insights; nothing is invented.
 */

export interface OfferRules {
  promoApproval: "YES" | "NO" | "UNSURE";
  maxDiscountPct: number;
  allowFreeExtra: boolean;
  allowPercentOff: boolean;
}

export interface OfferCandidate {
  key: "welcome" | "afternoon-drink" | "weekend-bread";
  category: string;
  title: string;
  schedule: string;
  why: string;
  audience: string;
  cost: string;
  measure: string;
  checks: string[];
  copyLabel: string;
  /** Short facts the copywriter may use, word for word */
  facts: string[];
  /** Whether the message must include the [CODE] placeholder */
  needsCode: boolean;
  evidence: { kind: "hourly"; bars: HourBar[]; highlight: number[]; caption: string } | null;
}

const money = (n: number, cents = false) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

export function isBrandSafe(rules: OfferRules) {
  return rules.promoApproval !== "YES";
}

/** Value of a giveaway as a share of the average order, in whole percent. */
export function valueSharePct(itemValue: number, averageTicket: number) {
  return averageTicket > 0 ? Math.round((itemValue / averageTicket) * 100) : Infinity;
}

function welcome(ins: Insights): OfferCandidate {
  const cookieCost = ins.unitCosts["cookies"];
  const visitors = ins.customers;
  return {
    key: "welcome",
    category: "Build your list",
    title: "Free cookie when you join our email list",
    schedule: "Always on · QR code at the counter and on receipts",
    why:
      "None of your reports show who your customers are, so you can't send regulars personal offers yet." +
      (visitors ? ` About ${visitors.toLocaleString("en-US")} customers visit each week.` : "") +
      " A small welcome gift turns some of them into an email list you own.",
    audience: "In-store customers who scan the QR code",
    cost: cookieCost !== undefined ? `About ${money(cookieCost, true)} per cookie, from your inventory report` : "One cookie per sign-up",
    measure: "Sign-ups per week",
    checks: ["Free extra, no price cut", "One per customer", "Unsubscribe link in every email"],
    copyLabel: "QR card headline",
    facts: ["Free cookie for joining the email list", "One per customer", "Code sent by email after sign-up"],
    needsCode: false,
    evidence: null,
  };
}

function afternoonDrink(ins: Insights, rules: OfferRules): OfferCandidate | null {
  const h = ins.hourly;
  if (!h || ins.drinkPct === null || !ins.averageTicket) return null;
  if (h.afternoonHourAvg >= h.lunchHourAvg) return null; // afternoons aren't slow
  if (!rules.allowFreeExtra) return null;

  const drinkPrice = ins.drinkPrice ?? null;
  const freeShare = drinkPrice ? valueSharePct(drinkPrice, ins.averageTicket) : null;
  // A free drink only if its value fits the discount limit; otherwise a $1 drink.
  const free = freeShare !== null && freeShare <= rules.maxDiscountPct;
  const dollarDrinkShare = drinkPrice ? valueSharePct(Math.max(0, drinkPrice - 1), ins.averageTicket) : null;
  if (!free && (dollarDrinkShare === null || dollarDrinkShare > rules.maxDiscountPct)) return null;

  const deal = free ? "Free fountain drink with any footlong" : "$1 fountain drink with any footlong";
  const shareUsed = free ? freeShare! : dollarDrinkShare!;
  return {
    key: "afternoon-drink",
    category: "Slow hours",
    title: `${deal}, 3–5 pm`,
    schedule: "Mon–Fri, 3–5 pm · for 4 weeks",
    why:
      `Noon to 3 pm brings in ${h.lunchShare}% of your sales. On weekdays an hour between 3 and 5 pm averages ` +
      `${money(h.afternoonHourAvg)}, against ${money(h.lunchHourAvg)} for a lunch hour. ` +
      `Only ${ins.drinkPct}% of orders include a drink, so this lifts afternoon visits and drink sales together.`,
    audience: "Your email list, plus the counter QR card",
    cost: drinkPrice
      ? `${free ? "A" : "Up to"} ${money(free ? drinkPrice : drinkPrice - 1, true)} drink per use (${shareUsed}% of an average order)`
      : "One drink per use",
    measure: "Uses, and 3–5 pm sales vs. now",
    checks: [`Within your ${rules.maxDiscountPct}% limit`, "Unique redemption code", "Ends after 4 weeks"],
    copyLabel: "Email subject",
    facts: [deal, "Monday to Friday, 3 to 5 pm", "Valid for 4 weeks", "Show the code at the counter"],
    needsCode: true,
    evidence: {
      kind: "hourly",
      bars: h.bars,
      highlight: [15, 16],
      caption: `Sales by hour for the week (total ${money(h.weekSales)}). Yellow: the 3–5 pm window this offer targets.`,
    },
  };
}

function weekendBread(ins: Insights, rules: OfferRules): OfferCandidate | null {
  const b = ins.bread;
  const d = ins.days;
  if (!b || !d || b.weekendSurplus <= 0 || d.weekendAvg >= d.weekdayAvg) return null;
  if (!rules.allowFreeExtra) return null;
  const surplusText = b.surplusDays
    .filter((x) => ["Sat", "Sun", "Mon"].includes(x.day))
    .map((x) => `${x.day} (+${x.bread})`)
    .join(", ");
  return {
    key: "weekend-bread",
    category: "Use extra stock",
    title: "Free chips with any 6-inch sub, Sat–Mon",
    schedule: "Sat–Mon · for 2 weeks",
    why:
      `Your bread report shows extra bread on ${surplusText}, while weekend days average ${money(d.weekendAvg)} ` +
      `against ${money(d.weekdayAvg)} on weekdays (busiest: ${d.busiest.day}, ${money(d.busiest.sales)}).`,
    audience: "Your email list",
    cost: ins.unitCosts["chips"] !== undefined ? `About ${money(ins.unitCosts["chips"], true)} per bag of chips` : "One bag of chips per use",
    measure: "Weekend sales and bread overage",
    checks: ["Free extra, no price cut", "Unique redemption code", "Ends after 2 weeks"],
    copyLabel: "Email subject",
    facts: ["Free chips with any 6-inch sub", "Saturday to Monday", "Valid for 2 weeks", "Show the code at the counter"],
    needsCode: true,
    evidence: null,
  };
}

export function buildOffers(ins: Insights, rules: OfferRules): OfferCandidate[] {
  const out: OfferCandidate[] = [];
  if (rules.allowFreeExtra) out.push(welcome(ins));
  const drink = afternoonDrink(ins, rules);
  if (drink) out.push(drink);
  const breadOffer = weekendBread(ins, rules);
  if (breadOffer) out.push(breadOffer);
  if (isBrandSafe(rules)) {
    for (const o of out) o.checks = [...o.checks, "Check with your brand before sending"];
  }
  return out;
}
