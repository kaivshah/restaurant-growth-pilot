# Restaurant growth pilot

A web app that helps restaurant owners, starting with quick-service franchisees like a Subway outlet in San Diego, win catering customers and bring regulars back. The AI drafts; the owner approves. Nothing is sent without their OK.

Name not decided yet, so the app calls itself **product**.

## What works now

### AI: free Gemini by default, Claude later

Everything is written and decided by a real AI model; there are no pre-written drafts. One free **Gemini** key runs both the copywriter and the AI analyst:

1. Go to [Google AI Studio](https://aistudio.google.com), click **Get API key → Create API key** (no card needed).
2. Put it in `.env` as `GEMINI_API_KEY`. `LLM_PROVIDER` and `ANALYST_PROVIDER` already default to `gemini`; `GEMINI_MODEL` defaults to `gemini-flash-latest` (Google's current Flash). Google retires model names for new keys from time to time; when that happens the app switches to the model Google suggests and logs a warning.
3. Restart `npm run dev`.

Without a key, the inbox says "AI isn't set up yet" and nothing is drafted.

**Free limits:** Gemini's free tier allows a limited number of requests per minute and per day (see your quota in AI Studio). A full refresh uses roughly 10–25 requests. When a limit is hit, the job waits and tries again after 2, 5, 10, 20, 30 and 60 minutes (or longer if Google asks), and the inbox shows "The AI is busy… we'll try again at 3:40 pm". Drafts already written are kept, and **Refresh ideas** / **Scan my area** tries again straight away. Retries happen while the app is open in a browser.

**Privacy:** on the free tier, Google may use what's sent to improve its models: the store's sales totals and offer facts, and in pitches the business name and the contact's first name. No customer data is sent. For production, use Claude or a paid Gemini project.

**Switching to Claude:** set `LLM_PROVIDER="anthropic"`, `ANALYST_PROVIDER="anthropic"` and `ANTHROPIC_API_KEY`, then restart.

### Milestone 3a: catering leads and pitches (sending comes in 3b)

After setup, and whenever the owner clicks **Scan my area**, a background job:

1. Finds the store on the map (Google Geocoding) and searches the delivery radius for offices, coworking spaces, schools, clinics, gyms and event venues (Google Places API (New) Text Search).
2. Scores each place (type, distance, whether it has a real website, review count) and explains the score in plain words. Closed places and places outside the radius are left out.
3. Looks up who orders food at the best places (Hunter.io domain search, office managers and admins first), and verifies the top email.
4. Finds upcoming events 7–60 days ahead (PredictHQ and/or Ticketmaster), scores them, and matches each venue to a nearby place so the venue can be pitched 2–6 weeks ahead.
5. Lets the AI lead analyst choose who to pitch and what to offer (free cookie platter, drinks tray or delivery, as the owner's rules allow), with the same checks as the offer analyst: every number it writes must come from the scan. With the analyst off, the top-scored leads and event venues get the default offer.
6. Drafts a pitch email for each, which must say a franchise is independently owned and operated. A scan puts up to `PITCHES_PER_SCAN` (15) pitches in the inbox: the AI's picks first ("AI pick"), then the best-scored businesses it didn't pick or skip ("Top match"). Pitches without a contact are allowed; **Find contact** spends one Hunter lookup on that business when you ask, or you can type a contact in. Any other business can be pitched from **Leads & events** with **Pitch this business**.

The **Catering** tab in the Approval Inbox shows each pitch with its fit score, reasons, event, contact (editable) and email (editable by hand or with AI). Skipping with a reason like "Wrong kind of business" keeps that business out of future pitches. Approving marks it ready: **nothing is sent yet**. Gmail sending, follow-ups and replies come in milestone 3b. The **Leads & events** page lists every business and event found, with filters, Google Maps links, exclude/include and manual contacts.

**Keys and quotas** (all optional; `fake` providers let you try everything without keys, see `.env.example`):

| Service | Variable | Notes |
|---|---|---|
| Google Maps Platform | `GOOGLE_MAPS_API_KEY`, `PLACES_PROVIDER=google` | Enable the Geocoding API and Places API (New). One scan makes about 7 calls. |
| Hunter.io | `HUNTER_API_KEY`, `CONTACTS_PROVIDER=hunter` | The free plan has 50 credits a month. Each scan uses at most `HUNTER_MAX_LOOKUPS` searches (2 for the trial), each plus one email check, and a domain isn't searched again for 30 days. |
| PredictHQ | `PREDICTHQ_API_KEY`, `PREDICTHQ_LOCATION_ID` | Best source for conferences and expos with attendance. The free plan searches saved locations only. |
| Ticketmaster Discovery | `TICKETMASTER_API_KEY` | Free, 5,000 calls a day. Ticketed games and concerts. |

A bad AI key or model stops the scan at the first draft with one clear message. Businesses from a different source (for example sample data from a `fake` test run) are removed on the next real scan, unless their pitch was approved. Events only appear when `TICKETMASTER_API_KEY` or `PREDICTHQ_API_KEY` is set.

Google's terms limit storing Place content, so businesses nobody acted on are removed after 30 days and refreshed on every scan. A rules change re-picks pitches from the last scan if it's under a day old; **Scan my area** always searches again. The City of San Diego special-events permit data was last updated in 2021, so it isn't used.

To try the scan without Google or Hunter keys (the emails are still written by Gemini, so `GEMINI_API_KEY` is needed):

```bash
PLACES_PROVIDER=fake CONTACTS_PROVIDER=fake EVENTS_PROVIDER=fake ANALYST_PROVIDER=fake npm run dev
```

### Milestone 2.5: the AI analyst

Turn it on with `ANALYST_PROVIDER` and the AI takes part in **deciding** what to offer, not just writing the email.

1. **It explores the data itself.** It uses read-only tools (`src/lib/analyst/tools.ts`) over everything the owner uploaded:
   - weekly summaries and sales by hour, by day and by part of the day
   - week-over-week comparisons
   - inventory usage and item costs
   - bread over/short and existing discounts
   - the owner's rules and past approve/skip decisions

   Rent, labor, royalties and profit are not exposed. Google data (nearby businesses, events, weather) will plug in as more tools in milestone 3.
2. **It decides.** It submits findings ("AI found this week") and up to 5 offer proposals: mechanic, item, days, hours, value, expected effect and confidence. It also decides whether to keep, change or drop each standard idea.
3. **Code verifies everything** (`src/lib/analyst/verify.ts`) before anything reaches the inbox:
   - Every cited number must equal what the cited tool returned, and every $ or % in the text must match the data.
   - Offers must stay within the discount limit, use only allowed offer types, follow brand-safe mode (free extras only) and run within the store's sales hours.
   - Near-duplicates and previously decided ideas are dropped.
   - Anything that fails is logged with its reasons on the **How the AI decided** page (`/inbox/analysis/<id>`).
4. **It learns over time.** Past approvals and skip reasons are given to the analyst on each run. A run is reused while the reports, rules and decisions are unchanged, so you don't pay twice.

| Setting | Notes |
|---|---|
| `ANALYST_PROVIDER=gemini` (default) | Free tier with `GEMINI_API_KEY`; model from `GEMINI_MODEL` |
| `ANALYST_PROVIDER=off` | Standard rule ideas only |
| `ANALYST_PROVIDER=anthropic` | `ANALYST_MODEL`: `claude-opus-5-5` (best, about $0.20–0.40 a run), `claude-sonnet-5-5` (about $0.10–0.20), `claude-haiku-5-5` (about $0.01). Opus 5.5 and Sonnet 5.5 runs use Claude's server-side fallback if a request is declined |
| `ANALYST_PROVIDER=ollama` | Free and local. Needs a model with tool calling (e.g. `qwen2.5:7b-instruct`); small models are less reliable, and the checks will block more of their ideas |
| `ANALYST_PROVIDER=fake` | Development only: a scripted analyst for trying the flow without a model |

Each run is stored in `AnalysisRun`: findings, accepted and rejected ideas, the decisions on standard ideas, every tool call, tokens and estimated cost.

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
4. `validateCopy` rejects copy with invented prices or percentages, discounts over the limit, a missing `[CODE]`, or HTML. The AI gets one chance to fix rejected copy; if it still breaks a rule, that idea isn't drafted and the job notes why.

#### Choosing the copywriter (`LLM_PROVIDER` in `.env`)

| Value | Cost | Notes |
|---|---|---|
| `gemini` (default) | Free tier | Set `GEMINI_API_KEY`; `GEMINI_MODEL` defaults to `gemini-flash-latest` |
| `ollama` | Free, runs on your computer | Install [Ollama](https://ollama.com), run `ollama pull qwen2.5:7b-instruct`, set `OLLAMA_MODEL`. Any instruct model works (Llama 3.1 8B, Mistral 7B…) |
| `anthropic` | About $0.0004 per draft with Claude Haiku 5.5 | Set `ANTHROPIC_API_KEY`; `ANTHROPIC_MODEL` defaults to `claude-haiku-5-5` |

#### Rate limits and failures

- Drafts are built by a background job queue (`DraftJob` table), one job at a time per restaurant, with at most 2 AI calls in flight.
- 429s, 5xx errors and timeouts (30 s) are retried with exponential backoff and jitter (≈1 s, 2 s, 4 s), honouring `retry-after`. Other errors aren't retried.
- If the AI is still busy, the whole job waits and retries later (see "AI" above); a bad key or other permanent error is shown in the inbox instead.
- Each restaurant gets at most `DAILY_DRAFT_CAP` new drafts a day (default 40, offers and pitches together).
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

### Starting over

- Wipe all data but keep the database: `npx prisma migrate reset` (answer `y`).
- Or delete the database and make a new one: `dropdb -U app restaurant_growth && createdb -U app restaurant_growth && npx prisma migrate dev`. If the `app` user is gone too, first run `CREATE USER app WITH PASSWORD 'app' CREATEDB;` in `psql` as the postgres user.
- Then **sign out** (or clear the site's cookies): the old sign-in points to a user that no longer exists. Sign in again and redo setup.
- Only the demo account: `psql "$DATABASE_URL" -c "DELETE FROM \"User\" WHERE email='demo-owner@example.com'"`.

Google, Hunter and Gemini count usage on their side; wiping the database doesn't reset it.

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
| `src/lib/llm/` | Copywriter providers (Gemini, Claude, Ollama), the Gemini client, retries, output checks |
| `src/lib/analyst/` | AI analyst: data tools, the tool-use loop (Claude, Ollama, scripted), checks and conversion to offers |
| `src/lib/drafts/` | Background jobs (offer drafts and area scans) and AI call logging |
| `src/lib/places/`, `src/lib/contacts/`, `src/lib/events/` | Google Places, Hunter.io, PredictHQ and Ticketmaster clients, each with a fake for testing |
| `src/lib/leads/` | Area scan pipeline, lead and event scoring, pitch drafting |
| `src/lib/analyst/leads/` | AI lead analyst: lead tools, pitch checks |
| `src/app/setup/` | The four setup steps and their server actions |
| `src/app/inbox/` | Approval Inbox (Customer offers and Catering tabs) |
| `src/app/leads/` | Leads & events page |
| `src/auth.ts` | Auth.js setup (Google, plus the dev-only demo login) |
| `prisma/schema.prisma` | Database tables |

## Next milestones

3b. **Catering sending:** Gmail sending with a daily cap, follow-ups on day 4 and 10, unsubscribe and suppression list, reply tracking and a pipeline board.
4. **Customer list:** QR email sign-up, redemption codes, email offers and results.
