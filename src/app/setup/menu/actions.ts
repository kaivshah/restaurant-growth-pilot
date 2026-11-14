"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { db } from "@/lib/db";
import { enqueueDraftJob, kickJobs, logAnalysisCall } from "@/lib/drafts";
import { MENU_CATEGORIES, applyRead } from "@/lib/menu";
import { MENU_FILE_LIMIT, readMenuFile } from "@/lib/menu/read";
import { requireRestaurant } from "@/lib/restaurant";

export type MenuReadState = { ok?: string; error?: string; notes?: string } | undefined;

/** A photo, PDF or CSV of the menu: Claude reads the prices onto the store's menu rows. */
export async function readMenu(_prev: MenuReadState, formData: FormData): Promise<MenuReadState> {
  const restaurant = await requireRestaurant();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a photo, PDF or CSV of your menu." };
  if (file.size > MENU_FILE_LIMIT) return { error: "That file is larger than 20 MB. A phone photo or a PDF export is fine." };
  const started = Date.now();
  const result = await readMenuFile(file.name, await file.arrayBuffer());
  if (!result.ok) return { error: result.message };
  if (result.via === "claude") {
    await logAnalysisCall(
      restaurant.id,
      { provider: "anthropic", model: process.env.MENU_MODEL || process.env.ANTHROPIC_MODEL || "claude" },
      { status: "DONE", turns: 1, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      started,
      "menu-read",
    );
  }
  const { updated, added } = await applyRead(restaurant.id, result.read);
  revalidatePath("/setup/menu");
  return {
    ok: `Read ${result.read.items.length} priced lines: ${updated} prices filled in${added ? `, ${added} new items added` : ""}. Check them below, then save.`,
    notes: result.read.notes,
  };
}

/** The edit table: prices, costs, on/off, and new lines typed by the owner. */
export async function saveMenu(formData: FormData) {
  const restaurant = await requireRestaurant();
  const items = await db.menuItem.findMany({ where: { restaurantId: restaurant.id }, select: { id: true } });
  const money = (v: FormDataEntryValue | null) => {
    const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
    return String(v ?? "").trim() === "" ? null : Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
  };
  for (const { id } of items) {
    const price = money(formData.get(`price-${id}`));
    const cost = money(formData.get(`cost-${id}`));
    if (price === undefined || cost === undefined) continue; // unreadable number: leave as it was
    const active = formData.get(`active-${id}`) === "on";
    await db.menuItem.update({ where: { id }, data: { price, cost, active, ...(price != null ? { source: "OWNER" } : {}) } });
  }
  // New lines: up to five at a time from the "Add an item" row(s).
  for (let i = 0; i < 5; i++) {
    const name = String(formData.get(`new-name-${i}`) ?? "").trim();
    const price = money(formData.get(`new-price-${i}`));
    if (!name || price == null) continue;
    const cat = String(formData.get(`new-category-${i}`) ?? "Subs");
    const category = (MENU_CATEGORIES as readonly string[]).includes(cat) ? cat : "Subs";
    await db.menuItem.upsert({
      where: { restaurantId_category_name_size: { restaurantId: restaurant.id, category, name, size: String(formData.get(`new-size-${i}`) ?? "").trim() } },
      create: { restaurantId: restaurant.id, category, name, size: String(formData.get(`new-size-${i}`) ?? "").trim(), price, isCatering: category === "Catering", source: "OWNER", sortOrder: 20_000 + i },
      update: { price, active: true, source: "OWNER" },
    });
  }
  const done = formData.get("done") === "1";
  await db.restaurant.update({ where: { id: restaurant.id }, data: { menuConfirmedAt: new Date() } });
  revalidatePath("/setup/menu");
  if (restaurant.setupCompletedAt) {
    // Prices changed after setup: the offers and catering offers are worth redoing.
    await enqueueDraftJob(restaurant.id, "DAILY");
    after(() => kickJobs());
    redirect("/setup/menu?saved=1");
  }
  redirect(done ? "/setup/rules" : "/setup/menu?saved=1");
}

/** Removes a line the owner added or that a read got wrong. Seeded lines are turned off instead (untick Sold here). */
export async function removeMenuItem(formData: FormData) {
  const restaurant = await requireRestaurant();
  const id = String(formData.get("id") ?? "");
  await db.menuItem.deleteMany({ where: { id, restaurantId: restaurant.id, source: { not: "SEED" } } });
  revalidatePath("/setup/menu");
}
