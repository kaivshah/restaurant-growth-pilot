/**
 * Subway's standard US menu, as a starting point with no prices: the owner
 * confirms what their store carries and types or photographs the local
 * prices. Line-ups change, so this is a seed to edit, not a source of truth.
 */

export type SeedItem = { category: string; name: string; sizes?: string[]; isCatering?: boolean; serves?: [number, number] };

export const MENU_CATEGORIES = ["Subs", "Wraps", "Salads", "Breakfast", "Sides", "Drinks", "Kids", "Extras", "Catering"] as const;

const SUB_SIZES = ["6-inch", "Footlong"];

const SUBS = [
  // Subway Series
  "The Philly", "The Outlaw", "The Monster", "The Boss", "Titan Turkey", "Grand Slam Ham", "All-American Club", "Subway Club",
  "Teriyaki Blitz", "Garlic Roast Beef", "The Beast", "The Champ", "The Great Garlic", "The Ultimate B.M.T.", "Bella Mozza",
  "Supreme Meats", "Elite Chicken & Bacon Ranch", "The MexiCali", "Pickleball Club",
  // Classics
  "Turkey Breast", "Oven Roasted Turkey", "Italian B.M.T.", "Black Forest Ham", "Meatball Marinara", "Steak & Cheese", "Tuna",
  "Veggie Delite", "Cold Cut Combo", "Rotisserie-Style Chicken", "Spicy Italian", "Sweet Onion Chicken Teriyaki", "Buffalo Chicken",
  "Chicken & Bacon Ranch", "Roast Beef", "Veggie Patty",
];

export const SEED_MENU: SeedItem[] = [
  ...SUBS.map((name) => ({ category: "Subs", name, sizes: SUB_SIZES })),
  ...["Turkey Breast Wrap", "Chicken & Bacon Ranch Wrap", "Italian B.M.T. Wrap", "Steak & Cheese Wrap", "Veggie Delite Wrap"].map((name) => ({ category: "Wraps", name })),
  ...["Turkey Breast Salad", "Chicken & Bacon Ranch Salad", "Veggie Delite Salad", "Tuna Salad", "Steak & Cheese Salad"].map((name) => ({ category: "Salads", name })),
  ...["Egg & Cheese", "Bacon, Egg & Cheese", "Black Forest Ham, Egg & Cheese", "Steak, Egg & Cheese"].map((name) => ({ category: "Breakfast", name, sizes: SUB_SIZES })),
  { category: "Sides", name: "Cookie" },
  { category: "Sides", name: "Footlong Cookie" },
  { category: "Sides", name: "Chips" },
  { category: "Sides", name: "Footlong Pretzel" },
  { category: "Sides", name: "Footlong Churro" },
  { category: "Sides", name: "Soup", sizes: ["Cup", "Bowl"] },
  { category: "Sides", name: "Apple Slices" },
  { category: "Drinks", name: "Fountain Drink", sizes: ["21 oz", "30 oz", "40 oz"] },
  { category: "Drinks", name: "Bottled Drink" },
  { category: "Drinks", name: "Bottled Water" },
  { category: "Drinks", name: "Coffee" },
  { category: "Kids", name: "Kids' Meal (mini sub, drink, side)" },
  { category: "Extras", name: "Double Protein", sizes: SUB_SIZES },
  { category: "Extras", name: "Extra Cheese", sizes: SUB_SIZES },
  { category: "Extras", name: "Bacon", sizes: SUB_SIZES },
  { category: "Extras", name: "Avocado", sizes: SUB_SIZES },
  { category: "Extras", name: "Make it a Meal (chips + drink)" },
  // Catering
  { category: "Catering", name: "Giant Sub", sizes: ["3 ft", "6 ft"], isCatering: true, serves: [10, 25] },
  { category: "Catering", name: "Classic Combo Platter", isCatering: true, serves: [5, 9] },
  { category: "Catering", name: "Flavor Craver Platter", isCatering: true, serves: [5, 9] },
  { category: "Catering", name: "Subway Fresh Fit Platter", isCatering: true, serves: [5, 9] },
  { category: "Catering", name: "Boxed Meal (6-inch sub, chips, cookie)", isCatering: true, serves: [1, 1] },
  { category: "Catering", name: "Boxed Meal (footlong, chips, cookie)", isCatering: true, serves: [1, 1] },
  { category: "Catering", name: "Cookie Platter (36)", isCatering: true, serves: [12, 36] },
  { category: "Catering", name: "Dessert Platter", isCatering: true, serves: [12, 24] },
  { category: "Catering", name: "Chips Bundle (12)", isCatering: true, serves: [12, 12] },
  { category: "Catering", name: "Bottled Drinks Bundle (12)", isCatering: true, serves: [12, 12] },
  { category: "Catering", name: "Catering Delivery", isCatering: true },
];

/** The rows the seed makes for one store: one per item per size. */
export function seedRows(): { category: string; name: string; size: string; isCatering: boolean; servesMin: number | null; servesMax: number | null; sortOrder: number }[] {
  const rows: ReturnType<typeof seedRows> = [];
  let n = 0;
  for (const item of SEED_MENU) {
    for (const size of item.sizes ?? [""]) {
      rows.push({ category: item.category, name: item.name, size, isCatering: Boolean(item.isCatering), servesMin: item.serves?.[0] ?? null, servesMax: item.serves?.[1] ?? null, sortOrder: n++ });
    }
  }
  return rows;
}
