# Site Intelligence — PLAN

Required by `BRIEF.md` §0 ("write `docs/site-intel/PLAN.md` covering what you
found, the storage decision and anything that blocks you").

Status: **Task 0 · S-01 · S-02 · S-03 · S-04 · S-06 · S-07.** Updated 12 September 2026.

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
| Task 0 — EPC register endpoint check | **Done.** No module existed, so one was built. See §2a. |
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

## 2a. Task 0 — the EPC register

The brief calls this housekeeping. It turned out to be the unlock for three
other sections.

There was no register retrieval module to check, so one was built:
`src/lib/site-intel/epc.ts` covers all three registers (domestic, non-domestic,
display), implements the resolution chain's `AddressRegister` interface, and
caches certificates per postcode for the source TTL.

### Endpoint

Targets `get-energy-performance-data.communities.gov.uk` by default; the legacy
`epc.opendatacommunities.org` is reachable via `EPC_API_BASE`. Both speak the
same API, and the host that answered is reported on every lookup so a silent
migration is visible. Recorded as **PRELAUNCH TICKET-01**; `npm run epc:verify --
<postcode>` queries both hosts and compares, breaking the result down per
register and per UPRN source.

### The thing worth knowing

**The register's UPRN is not uniformly authoritative.** `uprn-source`
distinguishes one the register matched algorithmically ("Address Matched") from
one an energy assessor typed into assessment software ("Energy Assessor"). Those
are not the same grade of identifier, so an address-matched UPRN is treated as
register-grade (T1) and an assessor-entered one as inferred (T3), with the
source reported on every certificate. Recorded as **TICKET-02** because it is
easy to undo by accident — anything that collapses both back to "has a UPRN"
reintroduces the problem.

### What it unlocked

`exact` is now reachable. Resolving *Unit 3, Carr Hill Industrial Estate,
Doncaster DN4 8DE* returns confidence `exact` at tier T1 via step (a), with
coordinates still taken from OS Open UPRN — the rule that Google coordinates are
never persisted is untouched, and so is the equivalent for the register.

More importantly, the profile now carries a **street address**, which lifts the
downstream matches out of postcode-only. Measured on the same site:

| | Before | After |
|---|---|---|
| Ownership (S-04) | all `postcode_only` | `postcode_and_address`, score 1.00 |
| VOA (S-06) | `postcode_only` | `postcode_and_address`, score 1.00 |
| Floor area | VOA only, uncheckable | VOA 1,520.75 m² (T3) vs EPC 1,465 m² (T1), 3.7% apart |

The multi-address title correctly stays at `postcode_only` (score 0.77) — a
title covering several addresses should not sharpen just because one address is
known.

One gap had to be closed for that to work: steps (b) to (e) resolve a UPRN
without ever seeing an address, because OS Open UPRN carries coordinates rather
than addresses. `profileForCandidate` now backfills the address from a
certificate matching the same UPRN, so a site resolved by map click or UPRN
lookup reaches the matchers with something to compare.

### Not verified

No live call has been made to either host — this network reaches neither. The
request shape follows the documented API and 32 tests cover the parsing,
selection, failure handling and register behaviour against fixtures.

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

**`exact` is now reachable** — see §2a. Step (a) is wired to the EPC register and
fires when `EPC_API_EMAIL` and `EPC_API_KEY` are set. Without credentials the
chain still runs and falls through to the geocode or postcode branch, resolving
at `probable` or `approximate`, both of which require human confirmation. That
remains correct behaviour rather than a bug.

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

## 2d. S-04 — corporate ownership

**Built without a specification.** The brief lists S-04 under section 10, "Out
of scope (later briefs)", in one line. Everything below is an assumption to
check against the real S-04 brief when it exists.

### The structural problem, which decides the whole design

The obvious join — building → polygon → title number → owner — **does not exist
on open data**. HM Land Registry's INSPIRE index polygons carry a Land
Registry-INSPIRE ID, *not* a title number; each one has to be typed into a web
form individually to reach the title. The bulk polygon-to-title linkage is the
**National Polygon Service, £20,000 a year**. CCOD and OCOD, meanwhile, are keyed
*by* title number.

So there is no free path from a resolved building to a definitive owner. This is
the same £20k gate identified in the investor note, and it is what Searchland and
its competitors are really paying for.

### What was built instead

The reverse join. CCOD and OCOD carry the property address and postcode as free
text, so a resolved site can be matched *against* them:

1. narrow by postcode (indexed);
2. score the address by token containment, with abbreviations expanded and noise
   words dropped;
3. return ranked candidates, every one at **tier T3, inferred**.

Quality is either `postcode_and_address` or `postcode_only`, never "exact".
Conflicting building numbers block an address match. A title covering several
addresses says so, because it weakens the match. The result object carries
`inferredFromAddress: true` permanently and a note stating it is a lead to
verify, not proof of ownership.

Companies House enrichment turns a proprietor's company number into status,
registered address, officers and **persons with significant control** — which is
the part that actually answers "who controls this landlord" for ESG work. Free,
but needs `COMPANIES_HOUSE_API_KEY`; without one, screening still runs and
reports company details as unavailable.

`portfolioFor(companyNumber)` answers the reverse question — everything a company
owns — via a GIN index on the proprietors JSON.

**31 further tests**, 115 across the suite.

### Two honesty fixes the tests and the run-through forced

- Companies House returning an unexpected shape was reading as "no officers".
  An empty list and a broken call now look different: a payload without an
  `items` array is a failure, and `unavailable` says so.
- The service was passing the postcode in as the site's address, which produced
  "address tokens agree 0%" — claiming a comparison that never happened. It now
  passes null, and the reason reads "No site address to compare, so the postcode
  is all that matched".

### Consequence worth stating plainly

Until the EPC register lands (Task 0), a SiteProfile has **no street address**,
so every ownership match is `postcode_only`. On a postcode with several
corporate titles that means several candidates and no way to choose between
them. Task 0 is therefore the unlock for S-04 as much as for S-01.

### Licence caution

CCOD and OCOD are **not plain OGL**. Both require registration and acceptance of
HMLR's own licence, which carries conditions on redistribution. The terms have
not been read — this build could not reach the pages — and `sources.yaml` marks
them accordingly. **Check before any commercial use or any client deliverable.**

## 2e. S-06 — VOA floor area and use class

**Built without a specification**, like S-04: the brief lists S-06 under section
10 in one line. Three facts about VOA data decided the design, and each is a
place a careless build would produce a confident wrong answer.

### 1. Asterisk-delimited, despite the .csv extension

The compiled rating list and summary valuation files are ASCII with fields
separated by `*`. Parsing them as CSV yields one enormous field per row. The
loader splits on `*`, prints the first parsed record for eyeballing, and takes
a position override from `VOA_LIST_MAP` / `VOA_SMV_MAP` as JSON — positions
follow the published data specification but have **not** been checked against a
real file.

### 2. A floor area is meaningless without its basis

Survey lines are measured on GIA, NIA, GEA or EFA depending on the class of
property, and these are not interchangeable — NIA excludes circulation and
plant, GEA includes external wall thickness. `totalAreaByBasis` sums **within**
a basis and never across, because adding a GIA line to an NIA line is arithmetic
on incompatible quantities. An unstated basis stays `unknown`; the loader never
defaults it to GIA.

This matters directly for the rest of NZC AI: energy intensity, CRREM pathways
and NZCBS targets are all per m², so the denominator changes the answer.

### 3. The VOA description is not a planning Use Class

"WAREHOUSE AND PREMISES" is a valuation description under VOA's own primary
description and SCat scheme. Planning Use Classes come from the Use Classes
Order and the site's planning history. `inferUseClass` maps only unambiguous
descriptions, returns null rather than guessing on anything else, and every
result carries `inferred: true` plus a note saying it is not a determination.

### Floor area reconciliation — the actual product value

The brief (section 7) asks for a `floor_area_check` when footprint × storeys
differs from the EPC floor area by more than 25%. VOA supplies a third figure,
so `compareAreas` generalises it: **every estimate is kept, with its basis and
tier, and divergence is reported rather than resolved.** Picking one silently
would be the wrong move — choosing the denominator is the assessor's judgement,
and it should be made visibly.

Flags: `floor_area_check` above 25% spread, `mixed_basis` where estimates sit on
different measurement standards, `no_floor_area` where none exists.

### No free UPRN linkage, again

The published list carries VOA's UARN, not a UPRN. The cross reference is in **OS
AddressBase Premium**, a paid product — the same shape of gap as the National
Polygon Service in S-04. So matching is by address, every result is tier T3, and
until Task 0 supplies a street address every match is `postcode_only`.

That is now the third place Task 0 is the unlock: S-01 confidence, S-04
ownership, S-06 assessment matching.

### Reuse

The address matcher was extracted to `address-match.ts` and is now shared by S-04
and S-06, which face the identical problem for the identical reason.

### One bug worth recording

Importing the area-basis label map into the client component pulled `voa.ts`,
and therefore `sources.ts` and `node:fs`, into the browser bundle — Turbopack
correctly refused to build. The constants moved to `area-basis.ts`, a leaf
module with no imports. Worth watching: every other site-intel import in the
client is `import type`, which erases; this was the first value import.

**30 further tests**, 145 across the suite.

## 2f. S-07 — natural language site search

S-07 is **out of scope in the brief** (§10 lists it in one line, with no
specification). It was built on instruction, so the design decisions below are
mine and need review rather than assumed-correct.

### The architecture is not a choice — §0 rule 2 decides it

> "Deterministic Python for every derived value. The local Ollama model may only
> write narrative from flags that already exist. **No site or client data goes
> to DeepSeek or the Anthropic API.**"

That rules out the obvious implementation, in which the question and the
candidate rows are handed to a model that picks the matches. It does not rule
out natural-language *input*: the query string is the user's own words, not site
or client data, and it never leaves the process either way. So:

```
query string  ->  deterministic parser  ->  structured filter  ->  SQL  ->  rows
```

No model is involved at any point. `parseQuery` is a pure function with no
network and no I/O; the whole parser is unit-testable, which is the second
reason to prefer it — a model-based matcher cannot be tested for the property
that actually matters here.

### The property that actually matters: what the search did NOT do

A search that silently drops a clause returns **more** rows than the question
asked for, and every extra row reads as an answer. This is the same failure mode
as "no constraints found" in S-02, one layer up, and it is handled in the same
way: never a bare result, always a statement of coverage.

There are two distinct ways a clause can fail to narrow the list, and they are
reported separately because the fix for each is different:

| channel | layer | meaning | example |
|---|---|---|---|
| `unparsed` | parser | the words were not recognised at all | "warehouses **near a motorway**" |
| `notApplied` | executor | recognised, but cannot be run over a corpus | "**not in a conservation area**" |

`unparsed` is produced by a `Consumed` span tracker: every matcher records the
character range it claimed, and whatever is left after filler words are removed
is reported verbatim. The parser cannot quietly ignore a phrase, because
ignoring it *is* the reporting mechanism — there is no path where a term is
neither consumed nor listed.

`notApplied` exists because constraints are screened per site against
planning.data at request time and are not stored for a whole corpus, so a
conservation-area filter genuinely cannot narrow a list of thousands. Running
the search without it and saying nothing would imply a filter that never ran.
Local authority is in the same category: the VOA list carries a district name,
but it is not reconciled to a planning authority, so filtering on it would be
unreliable — better to say so than to return a plausible wrong list.

Both are surfaced in three places: the API response fields, the `description`
string, and the UI, which prints them **above** the results rather than below.
A reader who has already scanned the list will not go looking for a caveat.

### The `description` string carries both layers

`describeQuery` describes the parse; `describeRun` folds in the execution
omissions. They are separate functions because they belong to separate layers,
but the API never emits the first without the second:

> "Searching for: Postcode district DN4; Not in a conservation area; Use:
> warehouse. These parts were understood but could NOT be applied: Not in
> conservation area. Results are therefore wider than the question asked."

`describeRun` and the `NotApplied` type live in `search-describe.ts`, a leaf
module, so that anything needing only to describe a run — the UI, a future
narrative writer under §0 rule 2 — can import it without pulling the connection
pool in behind it. Same reason `area-basis.ts` exists (see 2e).

### Corpus choice

The VOA rating list is the corpus, because it is the only loaded dataset that
gives a universe of buildings with a description, a postcode, a floor area and a
rateable value together. Everything else joins onto it:

| attribute | source | join precision |
|---|---|---|
| floor area, basis | `voa_survey_line` | exact (UARN) |
| use | `voa_assessment.primary_description` | exact (UARN) |
| EPC band | `epc_certificate` | **postcode** |
| overseas ownership | `corporate_title` where `dataset = 'ocod'` | **postcode** |
| grid headroom | `postcode_centroid` → `substation` | **postcode centroid, 5 km box** |

The last three are postcode-precision, which means "somewhere in this postcode",
not a fact about the building — exactly the T3 linkage problem recorded in 2d
and 2e, because it has the same cause: the authoritative identifier is behind a
paywall. Every affected row carries a caveat saying so. These are leads to
verify, not findings.

Floor area is summed **per basis** and the largest stated-basis total taken,
mirroring `headlineArea()` in `voa.ts`. Bases are never added together (see 2e).

### Small guards worth recording

- **Unbounded queries are refused.** A query that parses to no filter at all
  would return the entire rating list; it returns an error asking for a
  location, use or size instead.
- **An empty query is empty, not match-everything.** `parseQuery("   ")` sets
  `empty`, and nothing runs.
- **A full postcode is not also counted as a district.** "DN4 8DE" yields one
  postcode, not a postcode plus the district DN4, which would widen the search.
- **EPC comparators parse in one regex.** `epc E or worse` originally matched a
  bare-band branch first and never reached the trailing qualifier, silently
  filtering to band E alone. Leading and trailing qualifiers are now optional
  parts of a single pattern.

### What it cannot do, plainly

It searches the **loaded** data, which is two VOA assessments and one EPC
certificate. A zero result means nothing matched what is loaded; it says so in
those words rather than "no sites found". It cannot filter on constraints or
local authority (above), it cannot rank, and it does not resolve a building —
`/land/search` finds candidates, S-01 profiles one.

**34 parser tests plus 3 for `describeRun`**, 214 across the suite.

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

See `PRELAUNCH.md` for the full tickets; this is the index.

- **TICKET-01 EPC register endpoint migration** — *mitigated, watch.* The client
  targets `get-energy-performance-data.communities.gov.uk` by default, the
  legacy host is reachable via `EPC_API_BASE`, and the host that answered is
  reported on every lookup. No retirement date is published.
- **TICKET-02** UPRN provenance · **TICKET-03** attributions unverified ·
  **TICKET-04** constraint wording unapproved · **TICKET-05** CCOD/OCOD licence
  unread · **TICKET-06** VOA slugs and column positions unverified ·
  **TICKET-07** fixture sites not chosen · **TICKET-08** stack decision.
- NESO "GIS Boundaries for GB DNO Licence Areas" not yet loaded — needed for
  point-in-polygon DNO lookup (brief §5.1).
- NGED publishes via CKAN, not Opendatasoft; no adapter written.
- No recorded fixtures / contract tests yet (brief §9). Sample rows in
  `fixtures/substations.sample.json` are invented and tagged `fixture:sample`,
  with a UI banner — they are not recorded API responses. Local stub servers
  (ports 3900 planning.data, 3910 EPC) stand in for blocked egress in
  development; they are not recordings either.
- **No live call has been made to any external source.** Outbound HTTPS to every
  data host is refused by the environment's proxy, so every integration in this
  repo is verified against fixtures only.

## 6. Needs sign-off

- **Headroom RAG bands.** `src/lib/headroom.ts` currently screens at ≥10 MVA
  green, 2–10 amber, <2 red. These are our defaults, used only where the DNO
  publishes no rating of its own. Not a regulated classification.
- **Grid caveat wording.** Implemented verbatim from brief §5.4 in
  `src/lib/grid.ts`. Confirm it reads correctly.
- **Fixture sites.** The brief asks for 8 confirmed sites; none chosen yet.
- Stack and phase order — §3 above. Map library resolved (MapLibre).
- **S-07 use-keyword mapping.** `search-use.ts` maps words like "warehouse" and
  "industrial" onto regular expressions over the VOA primary description. That
  is an interpretation of VOA's vocabulary, not a published mapping, and it
  decides what a search returns. Needs a read-through.
- **S-07 postcode-precision joins.** EPC band, overseas ownership and grid
  headroom are matched by postcode, not to the building. Every row says so and
  §2f records why, but confirm the wording is strong enough — these are leads,
  and a reader must not take them as findings about a specific property.
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
- **CCOD/OCOD licence terms** — not plain OGL, not yet read. Blocking for any
  client-facing use of ownership data.
- **Whether the £20,000 National Polygon Service is worth buying.** Without it
  ownership stays inferred. With it, building → title → owner becomes
  definitive, and S-04 becomes a product rather than a lead generator.
- **Whether OS AddressBase Premium is worth buying.** Same shape of decision for
  S-06: it holds the UPRN-to-VOA cross reference, which would turn every
  assessment match from inferred to definitive.
- **VOA column positions.** Follow the published specification, never checked
  against a real file. First load will show whether they are right.
- **The use-class mapping table** in `voa.ts` — needs sign-off, and it
  deliberately covers only unambiguous descriptions.
- **Base map tile source.** OS Data Hub key needed for production; CARTO
  fallback has not had its terms checked for commercial use.
