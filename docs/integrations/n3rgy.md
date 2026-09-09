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

Storage is a JSON file (`data/consents.json`, gitignored, path via `CONSENT_STORE_PATH`) behind the `ConsentStore` interface in `src/lib/consent/store.ts`. Swap in a database implementation before multi-user deployment; nothing else needs to change.

Verification only proves that n3rgy currently grants access to our key. It does not replace holding the occupier's evidence; keep the letter of authority or n3rgy consent reference in `evidenceRef`.

## Portal outputs

- `MeterReading[]` with `intervalStart`, `intervalEnd`, `value`, `unit`, `status`, and `provenance` (`source: n3rgy`, `basis: measured`, `licence: consent_based`, attribution string, retrieval time, consent reference).
- Daily totals by UTC day.
- CSV export with provenance columns.

## Next steps

1. Persist readings and provenance to the portal database rather than fetching per request.
2. Scheduled daily pull per active consent with gap detection and expiry warnings.
3. Tariff import for cost analysis and market-based Scope 2 evidence.
4. Database-backed `ConsentStore` and user authentication before multi-user use.
5. Evidence file upload (letter of authority PDF) attached to the consent record.
