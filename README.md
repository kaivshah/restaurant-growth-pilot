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

**Speed:** requests are spaced to stay under the free per-minute limit (`GEMINI_RPM`, default 10), so a first run (offer analysis, offer emails, lead analysis and up to 15 pitches, roughly 30–40 requests) takes a few minutes. Offer drafting and the area scan run side by side, pitches appear in the inbox one by one, and the page and the server terminal show each step (`[scan] Writing pitch 4 of 15…`). On a paid Gemini project or Claude, raise `GEMINI_RPM` or switch providers for faster runs.

**Free limits:** Gemini's free tier allows a limited number of requests per minute and per day (see your quota in AI Studio). A full refresh uses roughly 10–25 requests. When a limit is hit, the job waits and tries again after 2, 5, 10, 20, 30 and 60 minutes (or longer if Google asks), and the inbox shows "The AI is busy… we'll try again at 3:40 pm". Drafts already written are kept, and **Refresh ideas** / **Scan my area** tries again straight away. Retries happen while the app is open in a browser.

**Privacy:** on the free tier, Google may use what's sent to improve its models: the store's sales totals and offer facts, and in pitches the business name and the contact's first name. No customer data is sent. For production, use Claude or a paid Gemini project.

**Checking the AI setup:** `npm run ai:check` sends one email-draft request and one tool call (like the analyst makes) using your `.env`, and prints which model answered and how long it took. The server terminal also prints every Gemini request: `[gemini] … answered in 4.2s`, waits for the free limit, and errors.

**Switching to Claude:** set `LLM_PROVIDER="anthropic"`, `ANALYST_PROVIDER="anthropic"` and `ANTHROPIC_API_KEY`, then restart.

### Milestone 4: your own customer list, personal codes and results

- **Sign-up by QR code.** **Customers → Print the QR poster** prints a sheet for the counter. Scanning it opens a public sign-up page (`/join/<your-link>`) where customers enter their email (first name optional) and tick that they agree to get offers. You can also add someone who said yes yourself.
- **Welcome gift.** Approve the "Free cookie when you join" offer in the Approval Inbox and every new sign-up gets a personal code on screen and by email, valid for 30 days. Joining again with the same email doesn't make a second code.
- **Send an offer to the list.** Approve an offer with a code (the drink or chips ideas, or AI ideas aimed at your list), then choose **Everyone**, **Regulars** (3+ codes used in 60 days) or **Haven't been back** (joined 30+ days ago, nothing used in 30 days) and press **Send to customers**. Each person gets their own code, which works until the offer's last day (from "Valid for 4 weeks"). Emails go out from your Gmail any day between 10 am and 7 pm, about a minute apart, up to the daily limit on the Customers page (100 by default; a personal Gmail can send about 500 a day in total). People who already got an offer are skipped, so pressing it again only reaches new sign-ups. **Stop the rest** cancels emails not yet sent.
- **Redeem at the counter.** **Redeem a code** works on a phone: type the code (spaces, dashes and small letters are fine), see whether it's valid, used or expired and who it belongs to, then **Give the offer and mark used**. A code can only be used once, even if two people press at the same moment.
- **Results.** Each offer shows codes given, emails sent, codes used and the use rate, in the inbox and on the Customers page.
- **Unsubscribes** work the same as for pitches: every email has the link and one-click headers, and an unsubscribe also stops any catering emails to that address. If someone signs up again, their emails turn back on.

The QR code points at `APP_URL`. On `localhost` a phone can't open it, so to try it from a phone set `APP_URL` to your computer's address on the same Wi-Fi (for example `http://192.168.1.20:3000`) or a tunnel, and restart.

### Milestone 3b: sending from Gmail, follow-ups, replies and the pipeline

- **Connect Gmail** (Email sending page). The app asks Google for two permissions: send email (only emails you approved) and read email (only to spot replies to those emails). Tokens are stored encrypted with `AUTH_SECRET`.
- **Approve a pitch → its sequence starts.** The first email goes out in the next send slot (weekdays 9–11 am San Diego time, a few minutes apart, at most 20 a day by default). Follow-ups go out on day 4 and day 10 in the same thread, unless the business replies. The AI writes both follow-ups in the background when you approve (one request covers up to 8 pitches); edit or remove them on the pitch any time before they send. **Stop sending** cancels what's left; **Undo approval** works until the first email is sent.
- **Replies** are checked every 10 minutes (`REPLY_CHECK_MINUTES`). A reply stops the follow-ups and appears under **Replies waiting** with a link to answer in Gmail. "Please remove me" replies and bounces add the address to the do-not-contact list.
- **Every email** has your outlet's address, the franchise line, an unsubscribe link (`/u/…`) and one-click unsubscribe headers (Gmail requires these from bulk senders). Unsubscribes are permanent; you can also add addresses yourself.
- **Pipeline** shows each deal: Scheduled → Contacted → Replied → Quote sent → Won / Lost.

**Setting up Gmail (one time):**

1. In Google Cloud Console → APIs & Services → Library, enable the **Gmail API** in the project that has your OAuth client.
2. OAuth consent screen: add the scopes `gmail.send` and `gmail.readonly`, and add yourself (the owner's Gmail) under **Test users**.
3. Credentials → your OAuth client → add the redirect URI `http://localhost:3000/api/gmail/callback` (and your production URL's later).
4. In `.env`: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, and `APP_URL="http://localhost:3000"`.
5. Run `npm run worker` next to `npm run dev`: the worker sends at the scheduled times and checks replies.

To try it without Google, set `GMAIL_PROVIDER="fake"`: "Connect Gmail" connects a test mailbox, and each pitch gets **Send the first email now** and **Pretend they replied** buttons.

### Milestone 3a: catering leads, events and pitches on request (sending comes in 3b)

**Scan my area** (also run when setup is finished) collects; it writes nothing and uses no AI tokens except one web search:

1. Finds the store on the map (Google Geocoding) and searches the delivery radius for offices, coworking spaces, schools, clinics, gyms and event venues (Google Places API (New) Text Search).
2. Scores each place (type, distance, whether it has a real website, review count) and explains the score in plain words. Closed places and places outside the radius are left out.
3. Finds upcoming events 7–60 days ahead: a **web search** (Gemini with Google Search) for conferences, expos, tournaments, community events and corporate events at the offices it found, plus PredictHQ and Ticketmaster when their keys are set. Each event is scored, and its venue or organiser is matched to a business so it can be pitched 2–6 weeks ahead. Web results link to the page they came from; check the details before pitching.

On **Leads & events** the owner browses **Events** and **Businesses** with filters (type, date range, distance, search, pitched or not) and sorting (date, best fit, closest, biggest crowd, AI picks). **Generate pitch** on any row:

- finds who to contact (the business, or an event's venue or organiser, looked up on Google if needed),
- looks up a contact with Hunter if there isn't one yet (only then, so credits aren't spent on places you never pitch),
- writes one pitch email with the AI, which must say a franchise is independently owned and operated.

**AI suggests** (optional, needs `ANALYST_PROVIDER`) lets the lead analyst look through the list and mark its top picks with reasons, using the same checks as the offer analyst (every number it writes must come from the scan). Pitches generated for an AI pick use its offer and reasons.

The **Catering** tab in the Approval Inbox holds the generated pitches: fit score, reasons, event, contact (editable) and email (editable by hand or with AI). Skipping with a reason like "Wrong kind of business" excludes that business. Approving marks it ready: **nothing is sent yet**. Gmail sending, follow-ups and replies come in milestone 3b.

**Customer offers** stay automatic: once reports are confirmed, the AI analyst and copywriter prepare offer ideas in the inbox.

**Keys and quotas** (all optional; `fake` providers let you try everything without keys, see `.env.example`):

| Service | Variable | Notes |
|---|---|---|
| Google Maps Platform | `GOOGLE_MAPS_API_KEY`, `PLACES_PROVIDER=google` | Enable the Geocoding API and Places API (New). A scan makes about 7 calls, plus up to 15 to place web-search events. |
| Gemini web search | `GEMINI_API_KEY` (`WEB_EVENTS="off"` turns it off) | One grounded search per scan. Google gives a separate free allowance for search grounding (reported as 5,000 a month for Gemini 3 models). |
| Hunter.io | `HUNTER_API_KEY`, `CONTACTS_PROVIDER=hunter` | Free plan: 50 credits a month. Used only when you generate a pitch for a business without a contact (one search plus one email check); a domain isn't searched again for 30 days. |
| PredictHQ | `PREDICTHQ_API_KEY`, `PREDICTHQ_LOCATION_ID` | Conferences and expos with attendance. The free plan searches saved locations only. |
| Ticketmaster Discovery | `TICKETMASTER_API_KEY` | Free, 5,000 calls a day. Ticketed games and concerts. |

Businesses from a different source (for example sample data from a `fake` test run) are removed on the next real scan, unless their pitch was approved. Google's terms limit storing Place content, so businesses nobody acted on are removed after 30 days and refreshed on every scan. A rules change reuses a scan under a day old; **Scan my area** always searches again.

To try it without Google or Hunter keys (sample businesses and events; pitches are still written by Gemini, so `GEMINI_API_KEY` is needed):

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

## Caching, background jobs and scaling

External lookups (Google, Hunter, web search, event APIs) go through a shared two-tier cache, pitches are written in batches, and slow work runs as background jobs. See [docs/architecture.md](docs/architecture.md). In short:

- `npm run worker` runs the background jobs in their own process. Run one or more next to the web app in production and set `JOBS_IN_WEB="false"` on the web servers; for local development you can skip it (the web app then runs jobs itself).
- On **Leads & events**, tick several rows and click **Generate pitches for ticked rows**: one AI request writes up to 8.
- `GEMINI_RPM` paces Gemini across every process (shared through Postgres). `CACHE="off"` turns the cache off.

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
| `src/lib/outreach/`, `src/lib/gmail/` | Pitch sequences, send times, replies, unsubscribes; Gmail API and the test mailbox |
| `src/lib/customers/` | Customer list: sign-up, personal codes, audiences, sending offers, redeeming, results |
| `src/app/customers/`, `src/app/join/`, `src/app/redeem/` | Customers page and QR poster, public sign-up page, counter redeem page |
| `src/auth.ts` | Auth.js setup (Google, plus the dev-only demo login) |
| `prisma/schema.prisma` | Database tables |

## Next milestones

5. **Mobile app.**
