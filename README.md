# Restaurant growth pilot

A web app that helps restaurant owners, starting with quick-service franchisees like a Subway outlet in San Diego, win catering customers and bring regulars back. The AI drafts; the owner approves. Nothing is sent without their OK.

Name not decided yet, so the app calls itself **product**.

## What works now

### Milestone 2: offer ideas in the Approval Inbox

After setup, the app turns the owner's confirmed reports into offer ideas, each with the numbers behind it and editable copy:

- **Welcome offer:** a free cookie for joining the email list, which builds the customer list.
- **Slow-hours offer:** a drink deal for weekdays 3–5 pm, with an hourly sales chart. It's a free drink only if the drink's value fits the owner's discount limit, otherwise a $1 drink.
- **Extra-stock offer:** free chips with a 6-inch sub, Sat–Mon, when the bread report shows weekend surplus.

The owner can approve, edit, skip (with a reason), undo, or ask the AI to rewrite a draft (up to 5 times). **Refresh ideas** rebuilds drafts; the same facts are never drafted twice.

#### How data reaches the AI

1. Reports in Postgres → `src/lib/insights` (plain calculations, unit-tested).
2. Insights + brand rules → `src/lib/offers` (which offers are allowed, every number in the text).
3. A small facts packet (restaurant name, offer, a few facts, rules) → the copywriter (`src/lib/llm`). It writes only the headline and message, as schema-checked JSON. Raw files, financials and employee data never leave the server.
4. `validateCopy` rejects copy with invented prices or percentages, discounts over the limit, a missing `[CODE]`, or HTML. Rejected copy falls back to the built-in template.

#### Choosing the copywriter (`LLM_PROVIDER` in `.env`)

| Value | Cost | Notes |
|---|---|---|
| `template` (default) | Free | Built-in wording; no AI rewrites |
| `ollama` | Free, runs on your computer | Install [Ollama](https://ollama.com), run `ollama pull qwen2.5:7b-instruct`, set `OLLAMA_MODEL`. Any instruct model works (Llama 3.1 8B, Mistral 7B…) |
| `anthropic` | About $0.0004 per draft with Claude Haiku 5.5 | Set `ANTHROPIC_API_KEY`; `ANTHROPIC_MODEL` defaults to `claude-haiku-5-5` |

#### Rate limits and failures

- Drafts are built by a background job queue (`DraftJob` table), one job at a time per restaurant, with at most 2 AI calls in flight.
- 429s, 5xx errors and timeouts (30 s) are retried with exponential backoff and jitter (≈1 s, 2 s, 4 s), honouring `retry-after`. Other errors aren't retried.
- If the AI still fails, the draft is written from the template, so the inbox always fills.
- Each restaurant gets at most `DAILY_DRAFT_CAP` new drafts a day (default 20).
- Every AI call is logged in the `LlmCall` table (provider, model, tokens, time, outcome, error).

#### Checking the data

Run `npx prisma studio` and open http://localhost:5555 to browse `ReportUpload`, `Draft`, `DraftJob` and `LlmCall`.

### Milestone 1

- **Sign-in** with Google, or a "Continue as demo owner" button in local development.
- **Setup, step 1:** restaurant name, franchise or independent, outlet address, catering radius, smallest order and opening hours.
- **Setup, step 2:** upload Subway back-office reports (CSV or Excel). The app recognises each report, reads the numbers and shows the key ones for the owner to confirm. It refuses labor files that list employee names.
  - Day Part / Hourly Sales & Units
  - WISR Sales Summary, Units Summary, Adjusted Cost of Goods (required)
  - WISR Inventory Items, Inventory Categories, Daily Cash / Bread Over-Short, Cash In Week (optional)
- **Setup, step 3:** placeholder for menu upload (next milestone).
- **Setup, step 4:** brand rules: whether local promotions need approval, the largest allowed discount, allowed offer types, and using the brand's catering menu.
- **Approval Inbox:** the shell and summary cards.

PDF reports are not read yet; the app asks for a CSV or Excel export instead.

## Run it locally

Requires Node 20+ and Postgres 14+.

```bash
npm install
cp .env.example .env          # then set DATABASE_URL and AUTH_SECRET (npx auth secret)
npx prisma migrate dev        # creates the tables
npm run dev                   # http://localhost:3000
```

Sign in with **Continue as demo owner** (only shown when `DEV_LOGIN=true` and not in production). For Google sign-in, set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`, with `http://localhost:3000/api/auth/callback/google` as an authorised redirect URI.

## Tests

```bash
npm test
```

The report parsers are tested against made-up reports in `fixtures/sample/` (same layout as the real exports, invented numbers, store 00000). Regenerate them with `npm run fixtures`.

Real store reports go in `fixtures/private/`, which git ignores. When files are there, an extra test checks them against numbers read by hand. **Never commit real reports:** they contain the store's sales, rent, labor and profit.

## Project layout

| Path | What's there |
|---|---|
| `src/lib/reports/` | Report detection and parsers (CSV and Excel share one grid-based path), plus the confirm-screen summary |
| `src/lib/insights/` | Calculations from confirmed reports |
| `src/lib/offers/` | Offer ideas and brand-rule checks |
| `src/lib/llm/` | Copywriter providers (template, Ollama, Claude), retries, output checks |
| `src/lib/drafts/` | Background job that builds drafts and logs AI calls |
| `src/app/setup/` | The four setup steps and their server actions |
| `src/app/inbox/` | Approval Inbox |
| `src/auth.ts` | Auth.js setup (Google, plus the dev-only demo login) |
| `prisma/schema.prisma` | Database tables |

## Next milestones

3. **Catering outreach:** area scan, lead scoring, email lookup, drafted pitches, sending from Gmail or Outlook with follow-ups, and reply tracking.
4. **Customer list:** QR email sign-up, redemption codes, email offers and results.
