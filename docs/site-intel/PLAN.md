# Site Intelligence — PLAN

Required by `BRIEF.md` §0 ("write `docs/site-intel/PLAN.md` covering what you
found, the storage decision and anything that blocks you").

Status: **S-03 grid layer, first cut.** Written 12 September 2026.

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
| Task 0 — EPC register endpoint check | **Cannot do.** No register retrieval module exists. Carried into §5 below. |
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

## 3. Blockers and conflicts — need James's decision

### 3.1 Stack conflict (blocking for architecture, not for this slice)

The brief specifies a **Python / FastAPI engine** (`engine/site_intel/*.py`,
pydantic models, port 8077). The instruction in this session was **Next.js and
Postgres**, given twice.

This slice was built in Next.js + TypeScript as instructed. The data model,
dataset registry, normalisation rules and screening logic all port to Python
cheaply; the API routes and UI do not. **Confirm which is authoritative before
more is built**, because the answer changes roughly half the code.

### 3.2 Map library conflict

The brief says **MapLibre by default, Google only on paid tiers**, and "free and
open data only". This session set up a Google Maps API key and asked for Google
Maps, which is what was built.

The brief's position is the safer one, and matches an independent constraint:
Google's terms forbid tracing or digitising **utility posts or electrical lines**
from satellite imagery, and forbid showing Google content with or near a
non-Google map. A MapLibre base with OS/OGL tiles avoids both, and keeps Google
for the visual-inspection and Solar API roles where it genuinely earns its place.

**Recommendation: switch the base map to MapLibre, keep Google for Solar API and
imagery inspection only.** Not done unilaterally — the key was just provisioned
for Google on request.

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
- Stack, map library and phase order — §3 above.
