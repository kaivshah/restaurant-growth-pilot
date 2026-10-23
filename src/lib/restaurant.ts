import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import { db } from "@/lib/db";

/** The signed-in user's id; sends anyone signed out to the sign-in page. */
export async function requireUserId(): Promise<string> {
  const id = await currentUserId();
  if (!id) redirect("/login");
  return id;
}

/** The owner's restaurant. v1 supports one restaurant per account. */
export async function getRestaurant(userId: string) {
  return db.restaurant.findFirst({
    where: { ownerId: userId },
    include: { outlets: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
}

/** Like getRestaurant, but sends the owner back to step 1 if they haven't saved it yet. */
export async function requireRestaurant() {
  const userId = await requireUserId();
  const restaurant = await getRestaurant(userId);
  if (!restaurant) redirect("/setup/restaurant");
  return restaurant;
}
