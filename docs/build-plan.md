# Build plan: the strongest growth tool a Subway owner can have

Written 2026-11-14 after a review of the `redesign-daily-plan` / `main` branch. This is the reference for what we are building next, in what order, and why. Update the status column as phases ship.

## Goal

The owner sets offer preferences and uploads their weekly reports. The app scans for nearby businesses and events. The AI analyses the reports and proposes in-store offers to **attract new customers, grow what visitors spend, and bring regulars back**, each with a rationale drawn from the documents. On the owner's click it picks catering prospects; on **Generate pitch** it chooses the catering offer for that business from the analysis and writes the email. Nothing is hard-coded: every offer and pitch is the AI's, built from the data, checked by code, approved by the owner.

Subway-specific for the pilot (one owner, one store). Cost-optimal by construction.

## Review findings (what the current branch gets wrong or lacks)

1. **The offer AI is steered down a fixed path.** Nine fixed "targets", six mechanics, three audiences; a checklist prompt with example fixes; the AI is told not to calculate; the analysis is cached by data hash so "Refresh ideas" returns the same answer.
2. **The AI can't see most of what a creative analyst would use.** No menu or prices (menu step is a stub); no item-level sales (12 regex-matched add-ons only); no per-day hourly detail; no calendar, season, holidays or the scanned local events; no owner goals; no outcomes loop (redemptions and send results never reach the AI); no customer-list facts.
3. **Catering is half-informed.** Six hard-coded scan categories; no catering menu or prices, so offers can't be concrete; event handling inconsistent; contacts and sending off (by choice for the pilot).
4. **Ingestion is Subway-shaped.** Only WISR and Day Part are parsed; other exports become 40×12 tables; no PDF or menu photo; two inconsistent "lunch" definitions (tools 11–2, insights noon–3).
5. **After approval an offer has no life.** No dates, no live list, no results, no comparison against `expected_effect`; Edit changes copy only, not terms.
6. **Quality unproven on real data.** All end-to-end checks used stand-in AI; no eval set; rejection rates unknown.
7. **Smaller:** single outlet; expense lines hidden from the AI (deliberate); residual hard-coded caps.

## Architecture decision

**Keep the Anthropic TypeScript SDK; no LangChain/LangGraph.** The app already has what a framework offers: a Postgres job queue with retries and one AI job per store, a tool loop with prefetched data, structured outputs, a verifier, result caching by input hash and an `LlmCall` log. A graph framework would wrap 6–8 sequential calls in another layer without adding durability or quality. Revisit only if we need long cyclic graphs with many human checkpoints; today the checkpoint is the Approval Inbox.

**Move from one prompt to a pipeline of specialised roles.** Each role is one Claude call with a structured output, orchestrated in plain TypeScript in the worker, each stage cached by the hash of its inputs and checked by code.

| Role | Model / effort | Job | Checked by |
|---|---|---|---|
| Data layer (code) | – | Parse, average, align, compute metrics, menu and calendar facts | tests |
| Diagnostician | Opus 5.5, start `medium` | 6–10 findings with explicit arithmetic ("3 pm = 17% of noon") | every number and calculation recomputed in code |
| Strategist | Opus 5.5, start `medium` | 10–12 diverse candidate offers, free-form mechanics, using menu, calendar, events, owner goals, past outcomes, an archetype library as inspiration | schema + rules |
| Critic | Opus 5.5, start `medium` | Scores lift, true cost (unit costs/margin), cannibalisation, feasibility, novelty; merges/drops; picks 5 across attract / grow / retain | cost model, discount limit, hours |
| Copywriter | Sonnet 5.5, `low` | Headlines, emails, QR card text | copy validator |
| Scout | Sonnet 5.5 | Extra business types to scan for this area, within a Google budget | code |
| Prospector | Opus 5.5 | Catering picks (exists; richer data) | existing checks |
| Catering strategist | Opus 5.5 | Concrete offer per business from the catering menu and the analysis | checks + cost model |
| Reviewer (weekly, Batch API) | Opus 5.5 | Compares new uploads with live offers; writes learnings the Strategist reads next time | code computes before/after |

Claude API facts this relies on (checked 2026-11-14): Opus 5.5 `claude-opus-5-5` ($4 in / $20 out per MTok, cache reads $0.20), thinking always on with `output_config.effort` (default `medium`), structured outputs via `output_config.format` / `messages.parse`, 1-hour prompt cache on stable prefixes, Message Batches at 50% off, server-side `fallbacks: "default"` on refusals. Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50.

## Cost model and controls

Per full in-store run at Opus `high`: Diagnostician ~$0.18, Strategist ~$0.23, Critic ~$0.14, copy ~$0.02 → **~$0.55–0.60** (vs ~$0.22 for today's single prompt). Runs happen only on change (weekly upload, or the owner asks for different ideas): ~12 a month → ~$7. Catering picks ~$0.60/month, ~40 pitches ~$0.70, Reviewer ~$0.60, menu reading ~$0.10 once. **About $9–10/month per store of Claude**; Google Places ~$2.50/month (scan cached 7 days).

Controls, built in from phase 1:
1. Run on change, never on a schedule; every stage cached by input hash; unchanged findings reuse the Strategist/Critic answers.
2. Right model per role (Opus for judgment, Sonnet for copy/Scout, Haiku for one-off classification such as inventory→menu mapping).
3. Effort per stage, starting at `medium`; raise only where the eval shows gain.
4. Prompt caching: stable blocks (role, archetypes, menu, calendar) first with 1-hour TTL; per-run data last.
5. Skip stages that add nothing (≤5 candidates → no Critic; "different ideas" reruns only the Strategist with a not-these list).
6. Batch API for anything not waiting on a click (Reviewer, overnight pre-computation).
7. Hard per-store monthly budget (default $15) pausing optional runs; cost page from `LlmCall`; Google scans capped per week.
8. Small requests by construction: aggregates, not raw files; "What the AI reads" stays visible to the owner.

Two further dials if needed: `medium` effort everywhere (~$6/month); merge Diagnostician + Strategist (~$4.50/month, less idea diversity). Decide with measurements, not guesses.

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Menu and item data | done (2026-11-15) |
| 3 | The pipeline (Diagnostician → Strategist → Critic → Verifier → Copywriter) | done (2026-11-15) |
| 2 | Owner voice, calendar and freedom | done (2026-11-16); weather not added |
| 4 | Offer lifecycle and the results loop | pending |
| 5 | Catering upgrades | pending |
| 6 | Prove it on real data (eval set, cost/latency page) | pending |

Order: 1 → 3 → 2 → 4 → 5 → 6, with a real-data check after phase 3.

### Phase 1: Menu and item data
- Menu upload: photo or PDF read by Opus vision into a structured menu (items, sizes, local prices, categories; catering platters and prices), with an edit table for the owner. Subway's standard catalogue pre-seeded so the owner mostly confirms prices. CSV/manual entry too.
- Item-level sales: the full WISR inventory-items list mapped to menu items (Haiku, once per new item), replacing the 12-item regex. Best/worst sellers, margin per item (unit cost vs price).
- Per-day hourly grid and week-by-week per-day detail to the AI.
- One definition of day parts shared by tools, insights and the brief.
- Menu facts in the daily context and the store report; `useBrandCateringMenu` starts to mean something.

### Phase 3: The pipeline
- Replace the single analyst with the four stages above; each stage its own `AnalysisRun` purpose, cached, checked.
- Archetype library (40–60 proven QSR offer shapes) as inspiration, never a pick-list.
- Analysis page shows each stage's reasoning.
- The verifier allows AI arithmetic when the calculation is stated and recomputes it.

### Phase 2: Owner voice, calendar and freedom
- "What matters this month" in rules; optional notes per upload.
- Calendar feed: date, season, US and local holidays, school terms, scanned local events; weather optional.
- Open mechanics/targets (controlled vocabulary only for inbox labels).
- "Give me different ideas" / "Ideas for …" buttons forcing a fresh Strategist run with a steer.

### Phase 4: Offer lifecycle and the results loop
- Approve sets start/end dates; Live offers page; editable terms with re-verification; per-offer results (codes, sends, targeted-window sales before vs after).
- Weekly Reviewer after each upload; learnings memory read by the Strategist.
- Report-due reminder.

### Phase 5: Catering upgrades
- Scout proposes extra categories within a budget; owner approves; scan runs.
- Concrete catering offers from the catering menu; emails may name items and prices.
- Consistent event handling (venue or organiser); event-specific catering ideas.

### Phase 6: Prove it on real data
- Eval set from the owner's real reports; log rejection rates per stage; tune prompts and checks.
- Cost and latency page from `LlmCall`.

## Inputs needed from the owner
1. The Subway menu with local prices (photo or price board) and the catering menu with prices.
2. OK to pre-seed Subway's standard catalogue.
3. Whether weather joins the calendar.
4. A real-data run after phase 3.

## Standing constraints
- Never commit real reports, bank or labor files (`fixtures/private` is ignored). Keys only in `.env`.
- No model identifiers in commits, PR text or code comments.
- Feature branches only; `main` moves by fast-forward when a phase is verified.
- Labor/payroll files hold personal data: refused on upload.
