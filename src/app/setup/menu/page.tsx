import { ButtonLink, Card, Notice } from "@/components/ui";
import { ensureMenu } from "@/lib/menu";
import { requireRestaurant } from "@/lib/restaurant";
import { saveMenu } from "./actions";
import { MenuTable, type Row } from "./menu-table";
import { MenuUpload } from "./menu-upload";

export default async function MenuStep({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const restaurant = await requireRestaurant();
  const { saved } = await searchParams;
  const settings = Boolean(restaurant.setupCompletedAt);
  const items = await ensureMenu(restaurant.id);
  const rows: Row[] = items.map((i) => ({
    id: i.id,
    category: i.category,
    name: i.name,
    size: i.size,
    price: i.price,
    cost: i.cost,
    active: i.active,
    source: i.source,
    serves: i.servesMin ? (i.servesMax && i.servesMax !== i.servesMin ? `${i.servesMin}–${i.servesMax}` : String(i.servesMin)) : null,
  }));
  const priced = rows.filter((r) => r.active && r.price != null).length;
  const cateringPriced = rows.filter((r) => r.active && r.price != null && r.category === "Catering").length;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-extrabold leading-tight tracking-tight">{settings ? "Menu & catering prices" : "Your menu and catering prices"}</h1>
        <p className="max-w-[66ch] text-muted">
          The AI uses your real items and local prices to build offers (&ldquo;free cookie with any footlong&rdquo; needs the cookie&apos;s price to check the discount), to name items in
          catering pitches, and to price platters. Start with a photo of your menu board; then fix anything it got wrong.
        </p>
      </div>
      {saved && <Notice tone="green">Menu saved.{settings ? " Offers and catering offers will be redone with the new prices." : ""}</Notice>}

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-bold">1. Read the prices from your menu</h2>
        <MenuUpload aiOn={Boolean(process.env.ANTHROPIC_API_KEY)} />
      </Card>

      <form action={saveMenu} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-bold">2. Check the list</h2>
            <p className="text-sm text-muted">Subway&apos;s standard line-up is pre-filled. Untick what you don&apos;t sell, type the prices you know.</p>
          </div>
          <MenuTable rows={rows} settings={settings} />
        </Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {priced} priced items{cateringPriced ? `, ${cateringPriced} catering` : ", no catering prices yet"}.{" "}
            {priced === 0 ? "Without prices the AI works from the sales reports only." : ""}
          </p>
          <div className="flex flex-wrap gap-3">
            {!settings && (
              <ButtonLink href="/setup/reports" variant="quiet">
                Back
              </ButtonLink>
            )}
            {!settings && (
              <ButtonLink href="/setup/rules" variant="secondary">
                Skip for now
              </ButtonLink>
            )}
            <button type="submit" name="done" value={settings ? "0" : "1"} className="inline-flex min-h-[52px] items-center justify-center rounded-field bg-primary px-6 font-bold text-white hover:bg-primary-hover">
              {settings ? "Save menu" : "Save and continue"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
