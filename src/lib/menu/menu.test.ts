import { describe, expect, it } from "vitest";
import { seedRows } from "./catalogue";
import { menuFacts, menuHash, readMenuCsv } from "./index";

describe("menu", () => {
  it("seeds Subway's line-up with one row per size and no prices", () => {
    const rows = seedRows();
    expect(rows.length).toBeGreaterThan(80);
    expect(rows.filter((r) => r.name === "Turkey Breast").map((r) => r.size)).toEqual(["6-inch", "Footlong"]);
    expect(rows.find((r) => r.name === "Giant Sub" && r.size === "3 ft")).toMatchObject({ isCatering: true, servesMin: 10 });
    expect(new Set(rows.map((r) => `${r.category}|${r.name}|${r.size}`)).size).toBe(rows.length); // unique keys
  });

  it("reads a CSV menu and guesses missing categories", () => {
    const r = readMenuCsv("name,size,price,serves\nTurkey Breast,Footlong,$11.99,\nCookie,,1.29,\nClassic Combo Platter,,54.99,serves 5-9\nFountain Drink,21 oz,2.59,\n");
    if ("error" in r) throw new Error(r.error);
    expect(r.items.map((i) => [i.name, i.category, i.price])).toEqual([
      ["Turkey Breast", "Subs", 11.99],
      ["Cookie", "Sides", 1.29],
      ["Classic Combo Platter", "Catering", 54.99],
      ["Fountain Drink", "Drinks", 2.59],
    ]);
    expect(readMenuCsv("a,b\n1,2")).toMatchObject({ error: expect.stringMatching(/name.*price/) });
  });

  it("turns the menu into facts for the AI and a hash that changes with prices", () => {
    const base = { id: "", restaurantId: "", cost: null, isCatering: false, servesMin: null, servesMax: null, active: true, source: "OWNER" as const, sortOrder: 0, inventoryNames: [], createdAt: new Date(), updatedAt: new Date() };
    const items = [
      { ...base, id: "1", category: "Subs", name: "Turkey Breast", size: "6-inch", price: 7.49 },
      { ...base, id: "2", category: "Subs", name: "Turkey Breast", size: "Footlong", price: 11.99 },
      { ...base, id: "3", category: "Sides", name: "Cookie", size: "", price: 1.29, cost: 0.35 },
      { ...base, id: "4", category: "Sides", name: "Chips", size: "", price: null },
      { ...base, id: "5", category: "Catering", name: "Giant Sub", size: "3 ft", price: 49.99, isCatering: true, servesMin: 10, servesMax: 12 },
    ];
    const f = menuFacts(items);
    expect(f.priced).toBe(4);
    expect(f.total).toBe(5);
    expect(f.lines).toEqual(["Subs: Turkey Breast 6-inch $7.49 / Footlong $11.99", "Sides: Cookie $1.29", "Catering: Giant Sub 3 ft $49.99"]);
    expect(f.items.find((i) => i.name === "Giant Sub")?.serves).toBe("10–12");
    const h1 = menuHash(items);
    expect(menuHash(items.map((i) => (i.id === "3" ? { ...i, price: 1.49 } : i)))).not.toBe(h1);
  });
});
