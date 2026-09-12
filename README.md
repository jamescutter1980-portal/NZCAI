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

## Google Maps setup

Enable exactly five APIs on the Cloud project: **Maps JavaScript**, **Places
(New)**, **Geocoding**, **Solar**, **Maps Static**.

Create two keys, never one:

- a **browser** key restricted by HTTP referrer → `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
- a **server** key restricted by IP → `GOOGLE_MAPS_SERVER_KEY`

Restrict each key to only the APIs it calls, and set a billing budget alert plus
per-API daily quota caps. `.env` is gitignored; keys must never be committed.

Two Google terms constrain the architecture (PLAN.md §3.2): tracing or
digitising utility posts or electrical lines from satellite imagery is
prohibited, and Google content cannot be shown with or near a non-Google map. So
every spatial calculation runs on OS / OGL / DNO geometry, and Google is a
viewing layer. A move to MapLibre for the base map is proposed but not made.

## Layout

```
db/migrations/       schema; 002 is an optional PostGIS upgrade
src/ingest/          registry (slugs, licences, attribution), ODS client,
                     field normaliser, verify/ingest CLI
src/lib/             db pool, types, headroom RAG bands, fixed grid wording
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

## Caveat

Grid figures are **indicative only, based on published DNO data. Not a
connection offer.** A connection application to the relevant DNO is required.
Headroom is network capacity in MVA — it is not a site's agreed supply capacity
in kVA, which is held per-MPAN and arrives with phase 3. Screening flags are for
review by a qualified person.
