# Backend architecture: caching, jobs and scaling

How the app keeps AI and API costs down and stays fast as more restaurants use it. Everything runs on Postgres today; Redis is an optional later step.

## Shape

```
 Browser ──▶ Web app (Next.js, N copies)          Worker (npm run worker, M copies)
              │  pages read Postgres only            │  claims jobs: FOR UPDATE SKIP LOCKED
              │  actions queue a job and return      │  runs: offers · area scan · AI suggests · pitches
              ▼                                      ▼
          ┌──────────────────────── Postgres ─────────────────────────┐
          │ DraftJob (queue) · CacheEntry (shared cache) · RateSlot    │
          │ Lead · Event · Contact · Draft · AnalysisRun · LlmCall     │
          └────────────────────────────────────────────────────────────┘
                                                     │
              external: Google Places/Geocoding · Gemini or Claude · Hunter · Ticketmaster · PredictHQ
```

- **Web app:** renders pages from the database and never waits on an AI or external API in a page load. "Generate pitch", "Scan my area", "AI suggests" and "Refresh ideas" add a `DraftJob` row and return in ~100–300 ms; the page shows progress and refreshes itself.
- **Workers:** take jobs off the queue. `claimNext` in `src/lib/drafts` uses `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, so any number of workers can run without taking the same job. A restaurant never has two jobs of one kind running at once. Jobs stuck in RUNNING for 10 minutes (a crash) go back in the queue. Busy AI → the job waits 2–60 minutes and retries (`retryLater`).
- **Single machine / local dev:** leave `JOBS_IN_WEB` unset and the web app also runs jobs after each request. In production set `JOBS_IN_WEB="false"` on the web service and run one or more worker services.

## Not paying twice

| What | How it's reused | Where |
|---|---|---|
| Google Places search | Shared cache, 7 days, key = category + point rounded to ~100 m + radius. Nearby restaurants reuse each other's results. (Google allows Place content up to 30 days.) | `cachedPlaces` in `src/lib/places` |
| Address → coordinates | Cached 30 days; outlets also keep their coordinates and re-geocode only when the address changes | `cachedPlaces`, `locate` |
| Hunter contacts | Cached 30 days per domain and per email check, shared by everyone; a lead isn't searched again for 30 days; lookups happen only when a pitch is requested | `cachedContacts`, `preparePitch` |
| Web event search | One grounded Gemini search per area + window + company list per day (6 h if it found nothing) | `cachedWebEvents` |
| Ticketmaster / PredictHQ | 6 hours per area and window | `cachedEvents` |
| Whole scan | A rules change within 24 h reuses the last scan; "Scan my area" always searches again | `scanArea` |
| AI analysis (offers, suggestions) | Reused while a hash of the data, rules and past decisions is unchanged | `ideasFor`, `suggestLeads` (`AnalysisRun.dataHash`) |
| A pitch or offer email | The same facts are never written twice (`Draft.factsHash`); an existing pitch is opened instead of rewritten | `planPitch`, `buildDraftsFor` |

The cache (`src/lib/cache`) has two tiers: an in-process LRU (500 entries) for repeats within seconds, and Postgres `CacheEntry` shared by every process. Concurrent calls for the same key share one in-flight request ("single flight"), so a burst of clicks makes one API call. Errors are never cached. `CACHE="off"` disables it.

## Sending less to the AI

- **Small packets, not whole datasets.** The copywriter only gets the facts for one email (company, distance, offer, a few lines). The analyst reads data through tools and only what it asks for.
- **Batches.** Ticked rows are written together: up to 8 pitches per request, with the restaurant's rules sent once (`batchPitchRequest`, `writeManyCopy`). Clicks that arrive while a job is waiting join the same batch (`enqueuePitches`). Any pitch that fails the checks is rewritten on its own.
- **Stable prefixes for provider caching.** Instructions come first and per-item facts last, so Gemini's automatic context caching can apply on longer prompts. The Claude analyst sets top-level `cache_control`, so each turn of its tool loop reads the earlier conversation from cache (about a tenth of the input price).
- **No AI until asked.** The area scan uses no AI except one web search; pitches are written only on request.

## Rate limits

- Gemini requests are spaced by `GEMINI_RPM` (default 10 for the free tier). The schedule is one `RateSlot` row in Postgres updated atomically, so all web servers and workers share one limit. After a 429, nobody sends until Google's delay has passed (capped at a minute; longer waits make the job retry later).
- Copy calls run at most 2 at a time per process; batches keep the count of requests low.

## Database

Indexes cover the Leads & events filters and sorts: `Lead(restaurantId, status, fitScore)`, `Lead(restaurantId, category, distanceMiles)`, `Event(restaurantId, category, startsAt)`, plus the existing queue and inbox indexes. Lists are capped at 150 rows per page.

## Running in containers

| Service | Command | Settings |
|---|---|---|
| Web (2+ copies behind a load balancer) | `npm run build && npm start` | `JOBS_IN_WEB="false"` |
| Worker (1+ copies) | `npm run worker` | same `.env`; scale up when the queue grows |
| Postgres | managed (e.g. RDS, Cloud SQL, Neon) | run `npx prisma migrate deploy` on release |

Use a connection pooler (PgBouncer, or the provider's pooled URL) once there are many web copies.

## Next steps when traffic grows

1. **Redis** (`REDIS_URL`): move the memory/shared cache tier and `RateSlot` to Redis for lower latency across many servers; keep Postgres as the source of truth for jobs, or move the queue to BullMQ.
2. **Streaming pitches:** stream the AI's text into the editor (server-sent events) so the first words appear in about a second.
3. **Message Batches API** (Claude) for large overnight runs at half price, when latency doesn't matter.
4. **Per-restaurant quotas** and an admin view of `LlmCall` costs.
