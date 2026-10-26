import { readUnsubscribeToken, suppress } from "@/lib/outreach";

/** One-click unsubscribe (RFC 8058): mail apps POST here from the List-Unsubscribe header. */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const who = readUnsubscribeToken((await params).token);
  if (!who) return new Response("This unsubscribe link isn't valid.", { status: 400 });
  await suppress(who.restaurantId, who.email, "unsubscribed");
  return new Response("You're unsubscribed. You won't get more emails from us.", { status: 200 });
}
