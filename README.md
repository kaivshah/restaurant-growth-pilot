# Restaurant growth pilot

A web app that helps restaurant owners, starting with quick-service franchisees like a Subway outlet in San Diego, win catering customers and bring regulars back. The AI drafts; the owner approves. Nothing is sent without their OK.

Name not decided yet, so the app calls itself **product**.

## What works now (milestone 1)

- **Sign-in** with Google, or a "Continue as demo owner" button in local development.
- **Setup, step 1:** restaurant name, franchise or independent, outlet address, catering radius, smallest order and opening hours.
- **Setup, step 2:** upload Subway back-office reports (CSV or Excel). The app recognises each report, reads the numbers and shows the key ones for the owner to confirm. It refuses labor files that list employee names.
  - Day Part / Hourly Sales & Units
  - WISR Sales Summary, Units Summary, Adjusted Cost of Goods (required)
  - WISR Inventory Items, Inventory Categories, Daily Cash / Bread Over-Short, Cash In Week (optional)
- **Setup, step 3:** placeholder for menu upload (next milestone).
- **Setup, step 4:** brand rules: whether local promotions need approval, the largest allowed discount, allowed offer types, and using the brand's catering menu.
- **Approval Inbox:** the shell and summary cards. Drafts arrive in milestones 2 and 3.

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
| `src/app/setup/` | The four setup steps and their server actions |
| `src/app/inbox/` | Approval Inbox |
| `src/auth.ts` | Auth.js setup (Google, plus the dev-only demo login) |
| `prisma/schema.prisma` | Database tables |

## Next milestones

2. **Insights and offers:** calculations from confirmed reports (slow hours, drink attach rate, discount share, catering, ingredient overuse) and Claude-drafted customer offers in the inbox.
3. **Catering outreach:** area scan, lead scoring, email lookup, drafted pitches, sending from Gmail or Outlook with follow-ups, and reply tracking.
4. **Customer list:** QR email sign-up, redemption codes, email offers and results.
