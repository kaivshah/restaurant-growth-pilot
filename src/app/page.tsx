import { redirect } from "next/navigation";
import { currentUserId } from "@/auth";
import { getRestaurant } from "@/lib/restaurant";

export default async function Home() {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const restaurant = await getRestaurant(userId);
  if (!restaurant) redirect("/setup/restaurant");
  redirect(restaurant.setupCompletedAt ? "/inbox" : "/setup/reports");
}
