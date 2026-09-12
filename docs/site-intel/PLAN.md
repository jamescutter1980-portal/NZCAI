# Site Intelligence — PLAN

Required by `BRIEF.md` §0 ("write `docs/site-intel/PLAN.md` covering what you
found, the storage decision and anything that blocks you").

Status: **S-01 resolve · S-02 constraints · S-03 grid.** Updated 12 September 2026.

---

## 1. What was found

The brief says "inspect both repos (engine and frontend). Reuse what already
exists." **Neither exists.**

`jamescutter1980-portal/nzcai` contained one commit and a two-line `README.md`.
There is no FastAPI engine on port 8077, no `engine/site_intel/`, no reusable
map component, no EPC/TM44 register retrieval module, no Supabase project, and
no W-11 / W-03 / W-23 Watershed-lift work. Nothing was reused because there was
nothing to reuse.

This means every "confirm the existing module" instruction in the brief is
currently unanswerable from this repository:

| Brief item | Status |
|---|---|
| Task 0 — EPC register endpoint check | **Cannot do.** No register retrieval module exists. Carried into §5 below, and it has a live consequence — see §2b. |
| Reuse the map component (MapLibre default) | **Cannot do.** None exists. See the conflict in §3. |
| Reuse W-03 tiers / W-23 lineage | **Cannot do.** Minimal compatible shapes added instead, per the brief's fallback. |
| Supabase PostGIS + storage check | **Cannot do.** No Supabase project reachable from here. |

## 2. What was built

A working Next.js 16 + Postgres slice of **S-03 (grid capacity)**:

- `db/migrations/001_init.sql` — `dno`, `substation`, `ecr_record`, `ingest_run`
- `db/migrations/002_postgis_optional.sql` — adds geography columns **only where
  PostGIS is available**, and no-ops otherwise
- `src/ingest/` — Opendatasoft Explore v2.1 client, dataset registry with
  licence and attribution per dataset, tolerant field normaliser, and a
  `verify` / `ingest` CLI
- `src/app/api/substations`, `src/app/api/health` — bbox and headroom filtering
- `src/components/LandMap.tsx` — map, filters, RAG-coloured substations

Verified end to end against a local Postgres 16: migrate → seed → API → bbox
filter → headroom filter all return correct results. `npm run build`,
`npx tsc --noEmit` and `npm audit` are all clean.

**Not** verified: any live DNO call. See §4.

### Storage decision (ADR summary)

The brief recommends a local PostGIS container for bulk reference data. That is
right for S-01, where OS Open UPRN is ~40M points. It is **not** needed for
S-03, which is ~400k substations and pure bounding-box filtering.

So: **PostGIS is optional, not required.** Coordinates are stored as plain
`double precision` lat/lng with a composite index; migration 002 adds
`geography(Point,4326)` columns and GIST indexes where the extension exists,
populating them from lat/lng so no re-ingest is needed.

Rationale: it keeps S-03 deployable on plain Postgres (Neon, Supabase, RDS)
without waiting on a PostGIS decision, while leaving the spatial upgrade a
one-command migration when S-01's bulk loads arrive and genuinely need it.
Revisit when OS OpenMap Local and title-boundary polygons land — those do need
PostGIS, and at that point the local container becomes the right call.

## 2b. S-01 — building resolution

Built in `src/lib/site-intel/`:

| Module | Does |
|---|---|
| `types.ts` | `SourceRecord`, `Tier`, `SiteProfile`, `ResultState` — the minimal W-03/W-23-compatible shapes the brief's fallback allows |
| `sources.yaml` + `sources.ts` | Dataset registry with licence, attribution and refresh cadence. Attribution lives in YAML, never in code |
| `geo.ts` | Distance, spherical area, point-in-polygon, WKT, postcode normalisation — dependency-free and deterministic |
| `planning-data.ts` | planning.data.gov.uk client with injectable fetch, plus `checkSlugs` |
| `resolve.ts` | The a–e resolution chain |
| `profile.ts` | Title extents, footprint, LPA, country, per-dataset states, overrides |
| `stores.ts` | Postgres-backed UPRN/postcode stores; PostGIS-backed footprints when available |
| `service.ts` | `getProfile`, `saveProfile`, `overrideProfile` |

API: `GET/POST/PATCH /api/site-intel/profile`. UI: address/postcode/UPRN search with
the "Is this the building?" confirm step, title extent outlined and footprint
filled on the map.

**53 unit tests pass** (`npm test`) covering the whole chain, state logic, tier
mapping, staleness, attribution rendering and the Google-coordinates guard.

### What is NOT resolvable, and why it matters

**Nothing resolves at `exact` right now.** Step (a) needs the EPC address
register, which does not exist in this repo (Task 0). Without it every address
falls through to the geocode or postcode branch, so it resolves at `probable` or
`approximate` — and both require a human to confirm. That is correct behaviour,
not a bug, but it means the confirm step is mandatory in practice for every
address. Wiring up the register is the single highest-value S-01 follow-up.

### Deviations from the brief, deliberate

1. **Postcode centroids are derived from loaded UPRNs, not Code-Point Open.**
   Code-Point publishes eastings/northings on OSGB36, which needs a full Helmert
   transform to reach WGS84. Averaging OS Open UPRN points already in the
   database avoids that dependency, uses authoritative OS coordinates, and
   centres on actual buildings. Swap to Code-Point if the transform lands.
2. **Postcode linkage needs a second file.** OS Open UPRN carries UPRN and
   coordinates but no postcode. `site:load-uprn` therefore accepts ONSUD too —
   run it once per file and the second pass fills postcodes in without clearing
   coordinates.
3. **`sources.yaml` attribution strings are transcribed from memory**, because
   this build could not reach the licence pages. Every entry is
   `attribution_verified: false`, `site:verify` lists them, and the API returns
   the unverified list on every profile. **Nothing should go to a client until
   each has been checked character for character.**

### Country derivation

From the GSS code's leading letter (E/W/S/N) where planning.data returns a local
authority — authoritative. Otherwise inferred from postcode area, but only for
areas that sit wholly within one country; `CH`, `SY`, `NP`, `TD` and `DG`
straddle the border and are deliberately left unanswered rather than guessed.
Inferred answers carry the `country_inferred_from_postcode` flag.

## 2c. S-02 — planning and environmental constraints

`constraints.ts` screens a resolved profile against the 21 datasets in brief
section 4.2, in two passes: the site geometry intersecting (`present`), then a
buffered box around it (`proximity`, 50 m by default, configurable). Wording
lives in `constraint_rules.yaml`; the code returns states and rule keys only.

**31 further tests** cover the state machine, the England gate, the buffer pass,
the flood cross-check and the narrative guard. 84 in total across the suite.

### Design decisions worth knowing

**`not_found_coverage_complete` is currently unreachable, deliberately.**
planning.data does not publish a per-dataset, per-LPA coverage guarantee we
could rely on, so every empty result is `not_found_coverage_unknown`. The UI
says "17 not confirmed" and explains that absence is not established. If the
organisation/provision endpoints turn out to give a usable coverage signal,
that is the one place to change.

**A hit on the site always outranks a hit nearby.** Pass 2 is filtered to
datasets not already `present`, *and* guarded on write. A test caught the
unguarded version silently downgrading a `present` constraint to `proximity`
when the source returned more than was asked for - which understates a real
constraint, the wrong direction to fail in.

**The 50 m buffer is a bounding-box buffer, not a true geometric buffer.** It
over-captures at the corners, so it may report something as nearby that is
slightly beyond 50 m. That is the safe direction for screening, and it is why
buffer results are `proximity` at tier T3, never `present`.

**A flood disagreement never clears risk.** Where the EA and planning.data
disagree, the constraint stays `present`, both readings are shown, and
`source_conflict` is raised. An unreachable EA is reported as unconfirmed, never
as an all-clear.

**No rule states a legal conclusion.** A test greps every rule for GPDO
references, "class A", and "consent is/is not required" and fails the build on a
hit. Rules say what was found and what to go and check.

### Narrative guard

`checkNarrative(text, screening)` implements brief section 7: generated text may
not claim "no constraints" while anything is coverage-unknown, deny flood risk
that was never confirmed absent, assert grid capacity is available, or name a
constraint that was not found. Five tests hold it. Wire it into the LLM
narrative path when that lands.

### Not done

- **EA flood endpoint is unverified.** `flood.ts` follows the documented ArcGIS
  REST convention but has never been exercised live. Every failure returns
  `null`, which reads as "could not confirm". Set `EA_FLOOD_SERVICE_URL` once the
  real path is known, or `EA_FLOOD_DISABLED=1` to skip it.
- **Bulk downloads for portfolio runs.** The brief wants bulk datasets beyond 50
  buildings; `BULK_THRESHOLD` is defined but nothing acts on it yet. Per-building
  API screening with a 250 ms pause is fine for single sites, not for a portfolio.
- **Welsh and Scottish constraints.** Return `not_supported` with a reason, as
  specified. DataMapWales and SpatialData.gov.scot are phase 2.
- **Surface-water flood risk** - out of scope for phase 1, per the brief.

## 3. Blockers and conflicts — need James's decision

### 3.1 Stack conflict (blocking for architecture, not for this slice)

The brief specifies a **Python / FastAPI engine** (`engine/site_intel/*.py`,
pydantic models, port 8077). The instruction in this session was **Next.js and
Postgres**, given twice.

This slice was built in Next.js + TypeScript as instructed. The data model,
dataset registry, normalisation rules and screening logic all port to Python
cheaply; the API routes and UI do not. **Confirm which is authoritative before
more is built**, because the answer changes roughly half the code.

### 3.2 Map library — RESOLVED, now MapLibre

Switched on request. The base map is MapLibre GL: Ordnance Survey vector tiles
where `NEXT_PUBLIC_OS_MAPS_API_KEY` is set, CARTO raster as a keyless fallback,
and a plain background if tiles cannot be fetched at all so the data stays
usable. Google is retained for the Solar API and static report images only.

This also removes the terms problem: Google bars digitising electrical
infrastructure from satellite imagery, and bars showing Google content alongside
a non-Google map — both of which a grid overlay would have run into.

Substations now render as a single GPU-drawn circle layer rather than per-marker
DOM, which is what makes the full ~400k set viable.

**One trap worth recording.** MapLibre v6 spawns a *module* worker that imports
a sibling shared chunk, and neither Turbopack nor webpack emits that pair
resolvably. The failure is silent: the source and layer are created, but the
worker never starts, GeoJSON never parses, and the map renders empty with no
error. Fixed by staging both files into `public/maplibre/` via
`scripts/copy-maplibre-worker.mjs` (wired to `predev`/`prebuild`) and calling
`setWorkerUrl()`. Downgrading to v4 also works but carries a critical XSS
advisory in `DOM.sanitize()` — which is the popup path, fed by DNO-sourced
names — so v6.9.0 plus the worker fix is the correct combination. Re-run
`npm run maplibre:worker` after any maplibre-gl upgrade.

### 3.3 Phase-ordering conflict

The brief sequences S-01 (resolve building) as P1 and S-03 (grid) as P3. The
plan agreed in this session put grid screening first. Grid was built first.

That is defensible — S-03 is independently useful and needs no UPRN — but it
means there is no building resolution yet, so the grid layer cannot currently be
attached to a specific site. **S-01 is the natural next piece either way.**

## 4. Datasets — verification status

**No live DNO call has been made.** This session's network policy blocks every
DNO portal (`403` on CONNECT to `*.opendatasoft.com`, `data.ssen.co.uk` and
`connecteddata.nationalgrid.co.uk`), via both HTTP client and fetch tooling. So
every slug below is **unverified except one**, and `licence` is provisional.

Run `npm run grid:verify` from an unrestricted network as the first action. It
resolves each slug, prints the true field list, shows how the first record maps,
and suggests catalogue alternatives when a slug 404s.

| DNO | API | Heatmap slug | Verified |
|---|---|---|---|
| NGED | CKAN | `network-opportunity-map-headroom` | ✗ — adapter not built |
| UKPN | ODS | `primary-substation-headroom`, `grid-and-primary-sites` | ✗ |
| Northern Powergrid | ODS | `heatmapsubstationareas`, `ltds-capacity-heatmap` | ✓ heatmap only |
| SSEN | ODS | `ltds-capacity-heatmap` | ✗ |
| Electricity North West | ODS | `enwl-gsp-heatmap` | ✗ |
| SP Energy Networks | ODS | `ltds-capacity-heatmap` | ✗ |

S-01 sources are in the same position. `planning.data.gov.uk`, `api.os.uk`,
`api.postcodes.io` and both EPC hosts all return `403` through this network's
egress proxy, so no S-01 dataset slug has been confirmed either. `npm run
site:verify` checks them and reports what is missing.

**Datasets left out on licence grounds: none yet** — because no licence has been
confirmed yet. Anything that turns out to bar commercial reuse gets removed from
`registry.ts` and listed here, per the brief.

**NGED is the gap that matters.** It is first in the brief's build order, and it
covers the Midlands, South West and South Wales — which is precisely where
NESO's Gate 2 outcome left solar headroom (zones T8 and T9). Its CKAN portal
needs its own adapter. Highest-value next piece of S-03.

## 5. Carried to PRELAUNCH

- **EPC register endpoint migration (Task 0).** EPC open data has moved to
  `get-energy-performance-data.communities.gov.uk`; the legacy
  `epc.opendatacommunities.org` API has no published retirement date. Cannot be
  checked until a register retrieval module exists. S-01 depends on it for UPRN
  matching.
- NESO "GIS Boundaries for GB DNO Licence Areas" not yet loaded — needed for
  point-in-polygon DNO lookup (brief §5.1).
- No `sources.yaml` yet; licence and attribution currently live in
  `registry.ts`. Move to YAML when S-01 and S-02 sources join.
- No recorded fixtures / contract tests yet (brief §9). Sample rows in
  `fixtures/substations.sample.json` are invented and tagged `fixture:sample`,
  with a UI banner — they are not recorded API responses.

## 6. Needs sign-off

- **Headroom RAG bands.** `src/lib/headroom.ts` currently screens at ≥10 MVA
  green, 2–10 amber, <2 red. These are our defaults, used only where the DNO
  publishes no rating of its own. Not a regulated classification.
- **Grid caveat wording.** Implemented verbatim from brief §5.4 in
  `src/lib/grid.ts`. Confirm it reads correctly.
- **Fixture sites.** The brief asks for 8 confirmed sites; none chosen yet.
- Stack and phase order — §3 above. Map library resolved (MapLibre).
- **All seven attribution strings in `sources.yaml`** — transcribed from memory,
  none verified against a licence page.
- **Fixture sites.** The brief asks for 8 confirmed sites (§9). None chosen.
  Needed before the golden-file and contract tests can be meaningful.
- **All 21 constraint wordings in `constraint_rules.yaml`** — every rule is
  `approved: false`. `site:verify` counts them and the API returns the
  unapproved list with every screening. Nothing should reach a client until
  these are signed off.
- **The 50 m proximity buffer** and whether it should differ per dataset (the
  setting of a listed building may warrant more than an AQMA).
- **Base map tile source.** OS Data Hub key needed for production; CARTO
  fallback has not had its terms checked for commercial use.
