import { Notice } from "@/components/ui";
import { getRestaurant, requireUserId } from "@/lib/restaurant";
import { RestaurantForm } from "./restaurant-form";

export default async function RestaurantStep({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const userId = await requireUserId();
  const restaurant = await getRestaurant(userId);
  const settings = Boolean(restaurant?.setupCompletedAt);
  const { saved } = await searchParams;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] font-extrabold leading-tight tracking-tight">{settings ? "Store & area" : "Let\u2019s start with your restaurant"}</h1>
        <p className="max-w-[60ch] text-muted">
          Your address tells us where to look for offices and schools that order catering.{" "}
          {settings ? "Changing the address or radius searches the area again." : "We start searching as soon as you save."}
        </p>
      </div>
      {saved && <Notice tone="green">Saved.</Notice>}
      <RestaurantForm
        settings={settings}
        defaults={{
          name: restaurant?.name ?? "",
          kind: restaurant?.kind ?? "FRANCHISE",
          brand: restaurant?.brand ?? "",
          address: restaurant?.outlets[0]?.address ?? "",
          radiusMiles: restaurant?.radiusMiles ?? 3,
          minCateringOrder: restaurant?.minCateringOrder ?? 10,
          openingHours: restaurant?.openingHours ?? "",
        }}
      />
    </>
  );
}
