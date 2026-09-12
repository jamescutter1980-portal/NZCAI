# NZCAI

NZC and ESG AI App.

The **Land** module screens sites against DNO grid capacity for solar PV — the
S-03 slice of the Site Intelligence layer. See
[`docs/site-intel/BRIEF.md`](docs/site-intel/BRIEF.md) for the full spec and
[`docs/site-intel/PLAN.md`](docs/site-intel/PLAN.md) for current status, open
decisions and what is not yet verified.

## Quick start

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and the Google Maps key
npm run db:migrate            # create schema, seed DNO rows
npm run db:seed               # optional: illustrative sample substations
npm run dev                   # http://localhost:3000/land
```

A Postgres is needed. Either use the bundled compose file:

```bash
docker compose up -d          # PostGIS on :5432, matches the default DATABASE_URL
```

…or point `DATABASE_URL` at any Postgres you already have. **PostGIS is
optional** — migration `002` adds geography columns where the extension exists
and no-ops where it doesn't, so plain Postgres (Neon, Supabase, RDS) works
unchanged. See PLAN.md §2 for why.

## Loading real grid data

`npm run db:seed` loads **invented sample rows**, tagged `fixture:sample`, so
the map renders before any ingest. The UI shows a banner whenever they are
present. For real data:

```bash
npm run grid:verify           # probe every dataset, print real field names
npm run grid:verify -- ukpn   # one DNO
npm run grid:ingest           # pull and load
npm run grid:ingest -- npg    # one DNO
```

**Run `grid:verify` first.** Dataset slugs in `src/ingest/registry.ts` are
mostly unverified — see PLAN.md §4. Verify resolves each slug against the live
portal, prints the true field list, shows how the first record maps, and
suggests catalogue alternatives when one 404s. Fix slugs in the registry, not in
code; add field aliases in `src/ingest/normalise.ts`.

## Base map

MapLibre GL, not Google. Two reasons: the brief specifies it, and Google's terms
bar both digitising electrical infrastructure from satellite imagery and showing
Google content alongside a non-Google map — which is exactly what a grid overlay
would be doing.

Tile source, in preference order:

1. **Ordnance Survey** — set `NEXT_PUBLIC_OS_MAPS_API_KEY` from
   [osdatahub.os.uk](https://osdatahub.os.uk). Right answer for production: OS
   is the authoritative UK base map and the same key serves the OS bulk products
   S-01 needs.
2. **CARTO raster** — keyless fallback so the app runs out of the box. Fine for
   development; confirm CARTO's terms before production use.
3. **Plain background** — if tiles can't be fetched at all, the map falls back
   automatically so substation data stays usable rather than showing a dead
   canvas.

### The MapLibre worker

MapLibre v6 spawns a *module* worker that imports a sibling shared chunk.
Neither Turbopack nor webpack emits that pair in a resolvable way, so the worker
never starts, GeoJSON sources never parse, and **nothing renders** — silently.

`scripts/copy-maplibre-worker.mjs` stages both files into `public/maplibre/`,
and the map calls `setWorkerUrl()` to point at them. It runs automatically via
`predev` and `prebuild`. **Re-run `npm run maplibre:worker` after upgrading
maplibre-gl** so the copies don't drift.

## Google Maps

Google is no longer the base map. The key is still used for the **Solar API**
(roof segments, pitch, azimuth, panel layout — UK covered at medium imagery
quality, 10,000 free Building Insights calls/month) and **Maps Static** images
in reports.

Enable: Maps JavaScript, Places (New), Geocoding, Solar, Maps Static. Create two
keys, never one — a browser key restricted by HTTP referrer, and a server key
restricted by IP. Restrict each to only the APIs it calls, and set a billing
budget alert plus per-API daily quota caps. `.env` is gitignored; keys must never
be committed.

## Layout

```
db/migrations/       schema; 002 is an optional PostGIS upgrade
src/ingest/          registry (slugs, licences, attribution), ODS client,
                     field normaliser, verify/ingest CLI
src/lib/             db pool, types, headroom RAG bands, fixed grid wording,
                     base map config
scripts/             MapLibre worker staging
src/app/api/         /api/substations (bbox + filters), /api/health
src/components/      LandMap
fixtures/            sample substations — invented, not DNO data
docs/site-intel/     BRIEF.md (spec), PLAN.md (status, blockers, sign-offs)
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | Apply migrations, seed DNO rows |
| `npm run db:seed` | Load sample substations |
| `npm run grid:verify` | Probe DNO datasets, report real schemas |
| `npm run grid:ingest` | Pull and load capacity heatmap + ECR |
| `npm run maplibre:worker` | Re-stage the MapLibre worker into `public/` |

## Caveat

Grid figures are **indicative only, based on published DNO data. Not a
connection offer.** A connection application to the relevant DNO is required.
Headroom is network capacity in MVA — it is not a site's agreed supply capacity
in kVA, which is held per-MPAN and arrives with phase 3. Screening flags are for
review by a qualified person.
