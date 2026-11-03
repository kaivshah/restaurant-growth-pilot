import { health } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

/** GET /api/health: 200 when the app can reach its database, 503 when it can't. For load balancers and uptime checks. */
export async function GET() {
  try {
    return Response.json(await health());
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "unavailable" }, { status: 503 });
  }
}
