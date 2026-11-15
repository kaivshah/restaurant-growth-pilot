/**
 * Proven quick-service offer shapes, given to the Strategist as inspiration.
 * It may adapt, combine or ignore them; it must never copy one without a
 * reason in the store's own numbers. Grouped by what they are for.
 */
export const ARCHETYPES: { goal: "attract" | "grow_sales" | "retain"; name: string; shape: string }[] = [
  // Attract: bring new people through the door
  { goal: "attract", name: "First-visit gift", shape: "A free side or drink on a first visit, claimed by joining the email list at the counter QR" },
  { goal: "attract", name: "Neighbour deal", shape: "A deal for staff of nearby businesses who show a work badge: a set lunch price or a free drink" },
  { goal: "attract", name: "Student / school hour", shape: "A set price or free side in the after-school hour for students with ID" },
  { goal: "attract", name: "Game-day or event tie-in", shape: "A deal around a local event or game day: a themed combo, or a discount with a ticket stub" },
  { goal: "attract", name: "Bring-a-friend", shape: "Two meals for a set price when two people come together, in a slow hour" },
  { goal: "attract", name: "Breakfast introduction", shape: "A cheap breakfast sub and coffee bundle before 10 am to start a morning habit" },
  { goal: "attract", name: "Catering-to-walk-in bridge", shape: "A walk-in voucher tucked into every catering order so office staff come in later" },
  { goal: "attract", name: "Holiday special", shape: "A limited-time combo built around a holiday or season, run for one or two weeks" },
  { goal: "attract", name: "Weather play", shape: "A warm soup-and-sub or cold-drink bundle promoted on the days the weather calls for it" },
  { goal: "attract", name: "Family evening", shape: "Kids eat for a set low price with an adult meal on a slow evening" },
  // Grow sales: more per visit, or more visits in a weak slot
  { goal: "grow_sales", name: "Happy hour", shape: "A deal valid only in the slowest two hours, e.g. a free drink or cookie with a footlong 2–4 pm" },
  { goal: "grow_sales", name: "Footlong upgrade", shape: "Upgrade a 6-inch to a footlong for a small fixed amount, where 6-inch sales dominate" },
  { goal: "grow_sales", name: "Make it a meal", shape: "Chips and a drink for a fixed add-on price with any sub, where drink attach is low" },
  { goal: "grow_sales", name: "Drink attach", shape: "A fountain drink for $1 (or free) with a footlong in a window where few orders include a drink" },
  { goal: "grow_sales", name: "Add-on nudge", shape: "A cookie or chips for a token price with any sub, promoted at the counter, where add-ons per customer are low" },
  { goal: "grow_sales", name: "Buy-one-get-one slot", shape: "Buy one footlong get one half price on the weakest day only" },
  { goal: "grow_sales", name: "Protein push", shape: "A small discount on the sub whose filling is over-stocked or wasted, until stock levels out" },
  { goal: "grow_sales", name: "Weak-day bundle", shape: "A set bundle price on the weakest weekday (sub + side + drink) to lift that day's average order" },
  { goal: "grow_sales", name: "Late-evening close-out", shape: "A deal in the last open hour to sell through bread and prepped items that would be wasted" },
  { goal: "grow_sales", name: "Premium trade-up", shape: "A free upgrade (double protein, bacon, avocado) with a premium sub to move people up the menu" },
  { goal: "grow_sales", name: "Group lunch", shape: "Order 4 or more subs together and get the drinks free, aimed at office lunch runs" },
  { goal: "grow_sales", name: "Second-item ladder", shape: "The second sub (or cookie) at a lower price, so one order becomes two" },
  // Retain: bring regulars back
  { goal: "retain", name: "Punch card", shape: "Buy N subs, get one free; counted at the counter or by code" },
  { goal: "retain", name: "Come-back coupon", shape: "A code on the receipt or by email valid for the next 7–10 days" },
  { goal: "retain", name: "Weekly regulars' day", shape: "A standing deal for email-list members on the same weekday each week" },
  { goal: "retain", name: "Birthday treat", shape: "A free cookie or sub in a member's birthday week" },
  { goal: "retain", name: "Win-back", shape: "An offer sent to list members who haven't used a code in 30 days" },
  { goal: "retain", name: "Streak reward", shape: "Visit 3 weeks in a row and the 4th week's sub is half price" },
  { goal: "retain", name: "Members' preview", shape: "A new item or seasonal sub at a member price for the first week" },
  { goal: "retain", name: "Lunch club", shape: "A set weekday lunch price for members, keeping the office crowd coming daily" },
];

export function archetypeLines(): string[] {
  return ARCHETYPES.map((a) => `- [${a.goal}] ${a.name}: ${a.shape}`);
}
