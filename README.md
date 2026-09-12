# NZCAI

NZC and ESG AI App.

The **Land** module resolves a building from an address (S-01), screens it for
planning and environmental constraints (S-02), and checks nearby DNO grid
capacity for solar PV (S-03). See
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

## Site intelligence (S-01)

Resolve a building from an address, postcode or UPRN, see its title extent,
footprint and planning authority, and confirm it is the right one.

```bash
npm run site:verify                       # readiness: data, slugs, attributions
npm run site:load-uprn -- osopenuprn.csv  # OS Open UPRN (coordinates)
npm run site:load-uprn -- onsud.csv       # ONSUD (fills in postcodes)
npm run site:postcodes                    # derive postcode centroids
```

OS Open UPRN is ~40M rows, distributed as a zipped CSV from
[osdatahub.os.uk](https://osdatahub.os.uk) — download `OpenUPRN`, unzip, and
point the loader at the CSV. It carries coordinates but **no postcode**, so run
the loader a second time against ONSUD to fill those in; the second pass updates
in place and never clears coordinates. Set `SITE_INGEST_LIMIT` to load a subset
while testing.

**Nothing resolves at `exact` yet.** That needs the EPC address register, which
does not exist in this repo (Task 0). Every address currently resolves at
`probable` or `approximate`, both of which require a human to confirm — which is
why the "Is this the building?" step is mandatory in practice.

Building footprints need PostGIS and an OS OpenMap Local load; until both are in
place the profile reports `unavailable` rather than inventing one.

### Attribution

Attribution strings live in `src/lib/site-intel/sources.yaml`, never in code.
**All seven are currently `attribution_verified: false`** — transcribed from
memory because this build could not reach the licence pages. `site:verify` lists
them and the API returns the unverified set with every profile. Check each
against its `licence_url` before anything reaches a client; they are licence
conditions, not decoration.

## Constraints (S-02)

Once a building is resolved it is screened against 21 planning and environmental
datasets on planning.data.gov.uk — conservation areas, listed buildings, Article
4 directions, Green Belt, flood zones, SSSIs, TPOs, AQMAs and the rest. Two
passes: intersecting the site (`on site`), then within 50 m (`within 50 m`,
configurable).

Three rules shape what you see:

- **Nothing found is not the same as nothing there.** Where coverage cannot be
  confirmed the result is "not confirmed", never a clean bill. planning.data
  publishes no per-dataset coverage guarantee, so that is the normal outcome for
  datasets with no hit.
- **A flood disagreement never clears risk.** The Environment Agency map is
  cross-checked against planning.data; where they differ, both are shown and the
  screening is flagged `source_conflict`. An unreachable EA reads as
  unconfirmed, not as an all-clear.
- **No legal conclusions.** Wording lives in `constraint_rules.yaml` and says
  what was found and what to check. A test fails the build if any rule starts
  claiming consent is or is not required.

**All 21 wordings are `approved: false`** pending sign-off. `site:verify` counts
them; the API returns the unapproved list with every screening.

England only. Welsh and Scottish sites return `not_supported` with a reason.

`checkNarrative()` guards generated text: it rejects "no constraints" while
anything is unconfirmed, a denial of flood risk that was never established, any
claim that grid capacity is available, and naming a constraint that was not
found.

Env: `EA_FLOOD_SERVICE_URL` to point at the EA service (the default path is
unverified), `EA_FLOOD_DISABLED=1` to skip the cross-check,
`PLANNING_DATA_BASE` to point at a fixture server.

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
src/lib/site-intel/  S-01: models, sources.yaml, geo, planning.data client,
                     resolution chain, profile builder, stores, service
                     S-02: constraint_rules.yaml, constraints, flood
tests/               unit tests + fixtures (constructed, not recorded)
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
| `npm test` | Unit tests (no network required) |
| `npm run site:verify` | S-01 readiness: reference data, slugs, attributions |
| `npm run site:load-uprn -- <csv>` | Load OS Open UPRN or ONSUD |
| `npm run site:postcodes` | Derive postcode centroids from loaded UPRNs |

## Caveat

Grid figures are **indicative only, based on published DNO data. Not a
connection offer.** A connection application to the relevant DNO is required.
Headroom is network capacity in MVA — it is not a site's agreed supply capacity
in kVA, which is held per-MPAN and arrives with phase 3. Screening flags are for
review by a qualified person.
