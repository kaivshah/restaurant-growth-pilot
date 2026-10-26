import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectFake, mailFromEnv, oauthUrl } from "@/lib/gmail";
import { startWaitingSequences } from "@/lib/outreach";
import { requireRestaurant } from "@/lib/restaurant";

/** Starts "Connect Gmail": Google's consent screen for sending and reading replies. */
export async function GET(request: Request) {
  const restaurant = await requireRestaurant();
  const back = new URL("/settings/email", request.url);
  const mail = mailFromEnv();
  if (!mail) return NextResponse.redirect(new URL("?error=Set+AUTH_GOOGLE_ID+and+AUTH_GOOGLE_SECRET+to+connect+Gmail", back));
  if (mail.name === "fake") {
    await connectFake(restaurant.id);
    await startWaitingSequences(restaurant.id);
    return NextResponse.redirect(new URL("?connected=1", back));
  }
  const state = randomBytes(16).toString("hex");
  (await cookies()).set("gmail_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/" });
  return NextResponse.redirect(oauthUrl(state));
}
