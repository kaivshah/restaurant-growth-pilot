import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { PITCH_GATHER_MS, type PitchTarget, enqueuePitches, kickJobs } from "@/lib/drafts";
import { requireRestaurant } from "@/lib/restaurant";

/**
 * Queues pitches. Called by the Generate pitch buttons with fetch(keepalive),
 * so a click still reaches the server if the owner reloads or leaves the
 * page straight away.
 */
export async function POST(req: Request) {
  const restaurant = await requireRestaurant();
  const body = (await req.json().catch(() => null)) as { targets?: unknown } | null;
  const values = Array.isArray(body?.targets) ? body.targets.filter((v): v is string => typeof v === "string").slice(0, 40) : [];
  const targets = values.flatMap((v): PitchTarget[] => (v.startsWith("event:") ? [{ eventId: v.slice(6) }] : v.startsWith("lead:") ? [{ leadId: v.slice(5) }] : []));
  if (!targets.length) return Response.json({ error: "Nothing to pitch." }, { status: 400 });
  await enqueuePitches(restaurant.id, targets);
  after(() => {
    setTimeout(() => kickJobs(), PITCH_GATHER_MS + 500).unref?.();
  });
  revalidatePath("/leads");
  revalidatePath("/inbox");
  return Response.json({ queued: targets.length });
}
