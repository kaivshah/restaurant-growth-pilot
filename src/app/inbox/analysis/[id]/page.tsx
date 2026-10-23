import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Pill } from "@/components/ui";
import { db } from "@/lib/db";
import { requireRestaurant } from "@/lib/restaurant";
import { AppShell } from "../../shell";

type Finding = { title: string; detail: string; citations: { label: string; value: number; source: string }[] };
type Offer = { key: string; title: string; schedule: string; why: string; confidence: string | null };
type Rejected = { kind: string; title: string; reasons: string[] };
type Decision = { key: string; action: "keep" | "change" | "drop"; reason: string };
type ToolEntry = { id: string; name: string; input: unknown };

const STANDARD_NAMES: Record<string, string> = {
  welcome: "Welcome cookie for joining the email list",
  "afternoon-drink": "3–5 pm drink deal",
  "weekend-bread": "Weekend chips deal for extra bread",
};

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const restaurant = await requireRestaurant();
  const { id } = await params;
  const run = await db.analysisRun.findFirst({ where: { id, restaurantId: restaurant.id } });
  if (!run) notFound();
  const pending = await db.draft.count({ where: { restaurantId: restaurant.id, status: "PENDING" } });

  const findings = (run.findings as unknown as Finding[] | null) ?? [];
  const accepted = ((run.accepted as unknown as { offers: Offer[] } | null)?.offers ?? []) as Offer[];
  const rejected = (run.rejected as unknown as Rejected[] | null) ?? [];
  const decisions = (run.baselineDecisions as unknown as Decision[] | null) ?? [];
  const tools = (run.toolLog as unknown as ToolEntry[] | null) ?? [];
  const when = run.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" });

  return (
    <AppShell current="inbox" pending={pending} restaurantName={restaurant.name} address={restaurant.outlets[0]?.address}>
      <div className="flex flex-col gap-2">
        <Link href="/inbox" className="font-bold">
          ← Back to the Approval Inbox
        </Link>
        <h1 className="text-[32px] leading-tight font-extrabold tracking-tight">How the AI decided</h1>
        <p className="text-ink-2">
          Analysis of {when} · {run.provider === "fake" ? "scripted test analyst" : `${run.provider} ${run.model}`} · {run.toolCalls} data lookups
          {run.estimatedCostUsd != null ? ` · about $${run.estimatedCostUsd.toFixed(4)}` : ""}
        </p>
      </div>

      {run.status === "FAILED" && (
        <Card className="p-6">
          <p className="font-bold">The analysis didn&apos;t finish.</p>
          <p className="text-ink-2">{run.error}</p>
        </Card>
      )}

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-bold">What it found</h2>
        {findings.length === 0 ? (
          <p className="text-ink-2">No findings passed the checks.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {findings.map((f) => (
              <li key={f.title} className="flex flex-col gap-1 border-t border-sand pt-3">
                <p className="font-bold">{f.title}</p>
                <p className="text-ink-2">{f.detail}</p>
                <ul className="text-sm text-muted">
                  {f.citations.map((c, i) => (
                    <li key={i}>
                      {c.label}: <strong className="text-ink">{c.value}</strong> ({c.source})
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-4 p-6">
          <h2 className="text-lg font-bold">Offers it proposed that passed every check</h2>
          {accepted.length === 0 ? (
            <p className="text-ink-2">None this time.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {accepted.map((o) => (
                <li key={o.key} className="flex flex-col gap-1 border-t border-sand pt-3">
                  <p className="font-bold">{o.title}</p>
                  <p className="text-sm text-muted">
                    {o.schedule}
                    {o.confidence ? ` · ${o.confidence} confidence` : ""}
                  </p>
                  <p className="text-[15px] text-ink-2">{o.why}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="flex flex-col gap-4 p-6">
          <h2 className="text-lg font-bold">Blocked by our checks</h2>
          <p className="text-sm text-muted">The AI suggested these, but they broke a rule or quoted a number that isn&apos;t in your reports, so they never reached your inbox.</p>
          {rejected.length === 0 ? (
            <p className="text-ink-2">Nothing was blocked.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {rejected.map((r, i) => (
                <li key={i} className="flex flex-col gap-1 border-t border-sand pt-3">
                  <p className="font-bold">
                    {r.title} <span className="font-semibold text-muted">({r.kind})</span>
                  </p>
                  <ul className="list-disc pl-5 text-sm text-ink-2">
                    {r.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-bold">What it decided about the standard ideas</h2>
        {decisions.length === 0 ? (
          <p className="text-ink-2">It didn&apos;t comment on them, so they were all kept.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {decisions.map((d) => (
              <li key={d.key} className="flex flex-wrap items-start gap-3 border-t border-sand pt-3">
                <Pill tone={d.action === "drop" ? "danger" : d.action === "change" ? "sun" : "green"}>
                  {d.action === "drop" ? "Dropped" : d.action === "change" ? "Changed" : "Kept"}
                </Pill>
                <span className="min-w-0 flex-[1_1_300px]">
                  <strong>{STANDARD_NAMES[d.key] ?? d.key}</strong>
                  <span className="block text-ink-2">{d.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <h2 className="text-lg font-bold">Data it looked at</h2>
        <ol className="list-decimal pl-5 text-sm text-ink-2">
          {tools.map((t) => (
            <li key={t.id}>
              <code className="font-semibold text-ink">{t.name}</code>
              {t.input && Object.keys(t.input as object).length ? ` ${JSON.stringify(t.input)}` : ""}
            </li>
          ))}
        </ol>
      </Card>
    </AppShell>
  );
}
