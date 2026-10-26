import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectWithCode } from "@/lib/gmail";
import { startWaitingSequences } from "@/lib/outreach";
import { requireRestaurant } from "@/lib/restaurant";

/** Google sends the owner back here after the consent screen. */
export async function GET(request: Request) {
  const restaurant = await requireRestaurant();
  const url = new URL(request.url);
  const back = new URL("/settings/email", request.url);
  const jar = await cookies();
  const expected = jar.get("gmail_oauth_state")?.value;
  jar.delete("gmail_oauth_state");
  if (url.searchParams.get("error")) return NextResponse.redirect(new URL(`?error=${encodeURIComponent("Gmail wasn't connected: " + url.searchParams.get("error"))}`, back));
  const code = url.searchParams.get("code");
  if (!code || !expected || url.searchParams.get("state") !== expected) {
    return NextResponse.redirect(new URL("?error=That+sign-in+link+expired.+Please+try+connecting+again.", back));
  }
  try {
    await connectWithCode(restaurant.id, code);
    await startWaitingSequences(restaurant.id);
    return NextResponse.redirect(new URL("?connected=1", back));
  } catch (err) {
    return NextResponse.redirect(new URL(`?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`, back));
  }
}
