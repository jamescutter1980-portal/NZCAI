# n3rgy integration

Consent-based half-hourly smart-meter data (electricity and gas) from the n3rgy data platform, https://data.n3rgy.com. This is the first connector in the portal and the reference pattern for the others: server-side key, MPxN-keyed requests, chunked retrieval, provenance on every value.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Set `N3RGY_API_KEY` to the key from the n3rgy customer self-service portal. Never commit it.
3. Set `N3RGY_ENV=sandbox` until n3rgy's back office has enabled the key for live data, then switch to `live`.
4. `pnpm install`, then `pnpm dev` and open http://localhost:3000/meters/n3rgy, or use the CLI:

```
pnpm n3rgy:pull --mpxn 1234567890123 --utility electricity --start 2026-08-01 --end 2026-08-31 --out data/exports/readings.csv
```

## How access works

- Requests are keyed by MPAN or MPRN (MPxN). The occupier must first grant consent to the portal's n3rgy account for that MPxN. Until then the API returns 403.
- Sandbox keys work against sample MPxNs supplied by n3rgy and need no consent.
- Live keys are enabled by n3rgy after business sign-up.
- The platform limits each request to 90 days. The client splits longer ranges automatically.
- n3rgy timestamps mark the end of each half hour. The normaliser converts them to interval start and end in UTC. If a live run shows the platform returning interval starts, set `timestampIsIntervalEnd: false`.

## Endpoints used

| Purpose | Path |
|---|---|
| Check MPxN is known | `GET /find-mpxn/{mpxn}` |
| Utilities for an MPxN | `GET /{mpxn}` |
| Reading types for a utility | `GET /{mpxn}/{utility}` |
| Consumption | `GET /{mpxn}/{utility}/consumption/1?start=YYYYMMDDHHmm&end=YYYYMMDDHHmm&granularity=halfhour\|daily&output=json` |
| Export / production | `GET /{mpxn}/{utility}/production/1?...` |
| Tariff | `GET /{mpxn}/{utility}/tariff/1?start=...&end=...&output=json` |

Hosts: sandbox `https://sandboxapi.data.n3rgy.com`, live `https://api.data.n3rgy.com` (override with `N3RGY_BASE_URL`). The API key is sent in both the `Authorization` and `X-API-KEY` headers because the platform's v1 and v2 endpoints read different ones.

## What is verified and what is not

Verified from published client code: sandbox host, path shapes, query parameter names and date format, the 90-day limit, response JSON shape for consumption and tariff, and the end-of-interval timestamp convention.

Not yet run against the live service from this repository, because the build environment cannot reach n3rgy hosts. Confirm on first run against your key:

1. The live host name.
2. Whether the live platform prefers `Authorization` or `X-API-KEY` (both are sent).
3. The exact shape of `find-mpxn` and listing responses (parsed loosely on purpose).
4. Whether consent registration can be done through the API or only through n3rgy's consent portal. The portal records consents and verifies them by probing n3rgy; it does not yet push consent requests to n3rgy.

## Consent capture

Live retrieval is gated. `/api/n3rgy/consumption` refuses with 403 unless an **active** consent exists for the MPxN and utility. Sandbox retrieval is exempt because n3rgy's sandbox MPxNs are test fixtures.

Consents live at `/consents` (UI) and `/api/consents` (JSON). Each record holds: MPxN, utilities covered, asset and site reference, occupier name, email and organisation, how consent was given (n3rgy consumer portal, letter of authority, lease or contract clause, other), an evidence reference, granted and expiry dates, notes, and the result of the last verification against n3rgy.

Lifecycle:

| Stored status | Effective status | Meaning |
|---|---|---|
| pending | pending | Recorded by us, not yet confirmed effective at n3rgy. Retrieval refused. |
| active | active | Verified, within term. Retrieval allowed; readings carry the consent id as `consentRef`. |
| active or pending | expired | Past the expiry date. Retrieval refused until renewed. |
| withdrawn | withdrawn | Occupier withdrew or tenancy ended. Retrieval refused. Reason and date stamped. |

**Verify** (`POST /api/consents/{id}/verify`) calls n3rgy's utilities listing for the MPxN. A 200 marks a pending consent active and records which utilities n3rgy lists; a 403 or 404 records a refusal and leaves the status alone so someone can chase the occupier. Verify again whenever n3rgy has been asked to add a consent.

**Renew** updates the expiry date. **Withdraw** sets the status with a reason; a fresh record is created if the same occupier consents again later.

Storage is the portal SQLite database (`SqliteConsentStore`) behind the `ConsentStore` interface. Set `CONSENT_STORE_PATH` to a JSON file to use the file store instead, for example in tests.

Verification only proves that n3rgy currently grants access to our key. It does not replace holding the occupier's evidence; keep the letter of authority or n3rgy consent reference in `evidenceRef`.

## Sync, storage and tariffs

`runN3rgySync` (`src/lib/sync/n3rgy-sync.ts`) pulls for every **active** consent and each utility it covers:

1. Import readings from the last stored interval (or 395 days back on first run, n3rgy's retention) to the end of yesterday UTC, 90 days per request, upserted into `meter_readings` with the consent id on each row.
2. Export readings for electricity; a 404 is recorded as "no export register", not an error.
3. Tariff prices per half hour and standing charges into `tariff_prices` and `standing_charges`. Tariff failures are warnings.
4. Gap detection across the stored window, written to the run log.
5. Warnings for consents expiring within 30 days, expired, or still pending.

Each run is logged in `sync_runs` and `sync_items` and shown on `/sync`. Runs are idempotent.

Run it:

- `pnpm n3rgy:sync` daily from cron, a systemd timer or Windows Task Scheduler. Exit code 1 if any meter errored.
- `POST /api/n3rgy/sync` from a hosted scheduler with `Authorization: Bearer $SYNC_TOKEN` (or `?token=`). Vercel Cron can use GET.
- The "Run sync now" button on `/sync`.

Storage is SQLite through Node's built-in driver (`DB_PATH`, default `data/portal.sqlite`, gitignored). Migrations are in `src/lib/db/sqlite.ts` and run on open. Node prints an "SQLite is an experimental feature" warning once per process; it is harmless. Moving to Postgres later means reimplementing `ReadingsRepository` and `SqliteConsentStore` against the same interfaces.

`/readings` and `GET /api/readings` serve stored data by meter and date range: daily totals, gaps, CSV, and an **indicative** cost from the stored tariff (unit rate × kWh plus standing charge per day, excluding VAT and anything the supplier did not report to n3rgy). Treat the cost as a sanity check, not a bill.

## Access protection

Set `PORTAL_BASIC_AUTH=user:password` to put HTTP Basic Auth in front of every route (`src/proxy.ts`). Sync requests carrying a valid `SYNC_TOKEN` bypass it so schedulers do not need the password. This is single-user protection for a hosted instance; real accounts are still to come.

## Portal outputs

- `MeterReading[]` with `intervalStart`, `intervalEnd`, `value`, `unit`, `status`, and `provenance` (`source: n3rgy`, `basis: measured`, `licence: consent_based`, attribution string, retrieval time, consent reference).
- Daily totals by UTC day.
- CSV export with provenance columns.

## Next steps

1. Link meters to portal assets (UPRN, site) so readings roll up to buildings and EUI.
2. Carbon: apply DESNZ factors and the Carbon Intensity API to stored readings (location-based, market-based, time-varying).
3. Evidence file upload (letter of authority PDF) attached to the consent record.
4. User accounts and roles in place of basic auth; Postgres in place of SQLite for multi-instance hosting.
5. Email or Slack notification when a sync errors or a consent is within 30 days of expiry.
