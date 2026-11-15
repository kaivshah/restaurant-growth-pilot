import type { MenuItem } from "@prisma/client";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { csvToGrid } from "@/lib/reports/cells";
import type { ParsedReport } from "@/lib/reports";
import { MENU_CATEGORIES, seedRows } from "./catalogue";

export { MENU_CATEGORIES } from "./catalogue";

/**
 * The store's menu with local prices: what the AI may name in an offer or a
 * pitch, what a free item costs, what a platter serves. Seeded from the brand
 * catalogue, then filled in from a photo, PDF or CSV read by Claude, or typed.
 */

/** Makes sure a store has its menu rows; returns them. */
export async function ensureMenu(restaurantId: string): Promise<MenuItem[]> {
  const count = await db.menuItem.count({ where: { restaurantId } });
  if (count === 0) {
    await db.menuItem.createMany({ data: seedRows().map((r) => ({ ...r, restaurantId })), skipDuplicates: true });
  }
  return db.menuItem.findMany({ where: { restaurantId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { size: "asc" }] });
}

/** One line read from a menu file, before it's matched to the store's rows. */
export const ReadItem = z.object({
  category: z.enum(MENU_CATEGORIES).describe("The closest of the listed categories"),
  name: z.string().max(80).describe("The item as printed, without the size"),
  size: z.string().max(20).default("").describe('"6-inch", "Footlong", "21 oz", "3 ft" and so on; empty when there is one size'),
  price: z.number().nonnegative().describe("The price in USD as printed"),
  serves: z.string().max(20).optional().describe('For catering, the serving note as printed, e.g. "serves 5-9"'),
});
export type ReadItem = z.infer<typeof ReadItem>;
export const MenuRead = z.object({ items: z.array(ReadItem).max(400), notes: z.string().max(300).optional().describe("Anything unreadable or ambiguous, for the owner") });
export type MenuRead = z.infer<typeof MenuRead>;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|sub|sandwich)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const normSize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^(6in|6inch|six|sixinch)$/, "6inch").replace(/^(12|12in|12inch|ftlong|foot)$/, "footlong");

/**
 * Puts the prices from a read onto the store's rows: a line whose name and
 * size match an existing row updates it; anything new is added as its own
 * row. Returns what changed, for the owner to check.
 */
export async function applyRead(restaurantId: string, read: MenuRead): Promise<{ updated: number; added: number }> {
  const rows = await ensureMenu(restaurantId);
  let updated = 0;
  let added = 0;
  for (const it of read.items) {
    const hit =
      rows.find((r) => norm(r.name) === norm(it.name) && normSize(r.size) === normSize(it.size)) ??
      rows.find((r) => normSize(r.size) === normSize(it.size) && (norm(r.name).includes(norm(it.name)) || norm(it.name).includes(norm(r.name))) && norm(it.name).length > 3);
    const serves = it.serves?.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
    if (hit) {
      await db.menuItem.update({ where: { id: hit.id }, data: { price: it.price, active: true, source: "READ", ...(serves ? { servesMin: Number(serves[1]), servesMax: Number(serves[2]) } : {}) } });
      updated++;
    } else {
      await db.menuItem.create({
        data: {
          restaurantId,
          category: it.category,
          name: it.name.trim(),
          size: it.size.trim(),
          price: it.price,
          isCatering: it.category === "Catering",
          servesMin: serves ? Number(serves[1]) : null,
          servesMax: serves ? Number(serves[2]) : null,
          source: "READ",
          sortOrder: 10_000 + added,
        },
      });
      added++;
    }
  }
  return { updated, added };
}

/** A CSV menu: columns category, name, size, price (and optionally serves). No AI needed. */
export function readMenuCsv(text: string): MenuRead | { error: string } {
  const grid = csvToGrid(text);
  const header = (grid[0] ?? []).map((c) => c.trim().toLowerCase());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const c = { category: col(["category", "section"]), name: col(["name", "item"]), size: col(["size"]), price: col(["price", "price usd", "usd"]), serves: col(["serves"]) };
  if (c.name < 0 || c.price < 0) return { error: 'A menu CSV needs "name" and "price" columns (and optionally "category", "size", "serves").' };
  const items: ReadItem[] = [];
  for (const row of grid.slice(1)) {
    const name = row[c.name]?.trim();
    const price = Number(String(row[c.price] ?? "").replace(/[$,\s]/g, ""));
    if (!name || !Number.isFinite(price)) continue;
    const cat = c.category >= 0 ? (row[c.category] ?? "").trim() : "";
    const category = (MENU_CATEGORIES as readonly string[]).includes(cat) ? (cat as ReadItem["category"]) : guessCategory(name);
    items.push({ category, name, size: c.size >= 0 ? (row[c.size] ?? "").trim() : "", price, serves: c.serves >= 0 ? row[c.serves]?.trim() || undefined : undefined });
  }
  return items.length ? { items } : { error: "No priced lines found in this CSV." };
}

function guessCategory(name: string): ReadItem["category"] {
  const n = name.toLowerCase();
  if (/platter|giant|boxed|catering|bundle/.test(n)) return "Catering";
  if (/wrap/.test(n)) return "Wraps";
  if (/salad/.test(n)) return "Salads";
  if (/egg/.test(n)) return "Breakfast";
  if (/cookie|chip|pretzel|churro|soup|apple/.test(n)) return "Sides";
  if (/drink|water|coffee|soda|oz\b/.test(n)) return "Drinks";
  if (/kid/.test(n)) return "Kids";
  if (/extra|double|bacon|avocado|meal/.test(n)) return "Extras";
  return "Subs";
}

/** The menu in a few lines for the AI: active, priced items by category, plus catering with servings. */
export interface MenuFacts {
  priced: number;
  total: number;
  /** "Subs: Turkey Breast 6-inch $7.49 / Footlong $11.99; …" */
  lines: string[];
  items: { category: string; name: string; size: string; price: number; cost: number | null; isCatering: boolean; serves: string | null }[];
}

export function menuFacts(items: MenuItem[]): MenuFacts {
  const active = items.filter((i) => i.active);
  const priced = active.filter((i) => i.price != null);
  const byCat = new Map<string, MenuItem[]>();
  for (const i of priced) byCat.set(i.category, [...(byCat.get(i.category) ?? []), i]);
  const lines: string[] = [];
  for (const [cat, list] of byCat) {
    const byName = new Map<string, MenuItem[]>();
    for (const i of list) byName.set(i.name, [...(byName.get(i.name) ?? []), i]);
    const parts = [...byName.entries()].map(([name, sizes]) =>
      sizes.length === 1 && !sizes[0].size
        ? `${name} $${sizes[0].price!.toFixed(2)}`
        : `${name} ${sizes.map((s) => `${s.size} $${s.price!.toFixed(2)}`).join(" / ")}`,
    );
    lines.push(`${cat}: ${parts.join("; ")}`);
  }
  return {
    priced: priced.length,
    total: active.length,
    lines,
    items: priced.map((i) => ({
      category: i.category,
      name: i.name,
      size: i.size,
      price: i.price!,
      cost: i.cost,
      isCatering: i.isCatering,
      serves: i.servesMin ? (i.servesMax && i.servesMax !== i.servesMin ? `${i.servesMin}–${i.servesMax}` : String(i.servesMin)) : null,
    })),
  };
}

/** The menu's own hash, so cached analyses rebuild when prices change. */
export function menuHash(items: MenuItem[]): string {
  return items
    .filter((i) => i.active)
    .map((i) => `${i.name}|${i.size}|${i.price ?? ""}|${i.cost ?? ""}`)
    .sort()
    .join("\n");
}

/**
 * The menu facts and inventory links for a store, for the analyst context.
 * New inventory lines are linked on the way (one small AI request, cached
 * for good), unless `mapNew` is false (pages that must not call the AI).
 */
export async function loadMenuContext(restaurantId: string, inventoryLines: string[] = [], mapNew = true) {
  const { ensureInventoryMap, loadInventoryMap } = await import("./inventory");
  const items = await ensureMenu(restaurantId);
  const menu = menuFacts(items);
  const inventoryMap = mapNew && inventoryLines.length ? await ensureInventoryMap(restaurantId, inventoryLines, menu) : await loadInventoryMap(restaurantId);
  return { menu, inventoryMap, hash: menuHash(items) };
}

/** The inventory report's line names across the uploaded weeks (not subtotals). */
export function inventoryLineNames(reports: ParsedReport[]): string[] {
  const names = new Set<string>();
  for (const r of reports) if (r.type === "wisrInventoryItems") for (const i of r.items) if (!i.isSubtotal && i.item) names.add(i.item);
  return [...names];
}
