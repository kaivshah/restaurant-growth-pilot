import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeInsights } from "@/lib/insights";
import { type ParsedReport, parseReportFile } from "@/lib/reports";
import { storeBrief } from "./index";

const SAMPLE = join(process.cwd(), "fixtures", "sample");

async function sampleReports(): Promise<ParsedReport[]> {
  const out: ParsedReport[] = [];
  for (const name of readdirSync(SAMPLE).filter((n) => n.endsWith(".csv"))) {
    const buf = readFileSync(join(SAMPLE, name));
    const r = await parseReportFile(name, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    if (r.ok) out.push(r.report);
  }
  return out;
}

describe("store brief", () => {
  it("sums the store up in a few short lines the AI can use", async () => {
    const brief = storeBrief(computeInsights(await sampleReports()), { minCateringOrder: 10, radiusMiles: 3, openingHours: "Mon–Sun 9 am–10 pm" });
    const text = brief.join("\n");
    expect(brief.length).toBeGreaterThanOrEqual(5);
    expect(brief.length).toBeLessThanOrEqual(10);
    expect(text).toMatch(/Weekly net sales about \$/);
    expect(text).toMatch(/Lunch \(noon–3 pm\) brings \d+% of sales/);
    expect(text).toMatch(/Quietest daytime hours: /);
    expect(text).toMatch(/Catering: from 10 people, delivered within 3 mi; open Mon–Sun/);
    // Short enough to send with every request.
    expect(text.length).toBeLessThan(1000);
  });
});
