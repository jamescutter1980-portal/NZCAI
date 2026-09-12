# Site Intelligence — PLAN

Required by `BRIEF.md` §0 ("write `docs/site-intel/PLAN.md` covering what you
found, the storage decision and anything that blocks you").

Status: **Task 0 · S-01 · S-02 · S-03 · S-04 · S-05 · S-06 · S-07 · S-08.**
Updated 12 September 2026. S-03 completed against brief §5 (see §2i).

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

## 2g. S-05 — EPC and building performance

S-05 is **not in the brief at all.** The brief covers S-01 to S-03 and lists
S-04, S-06, S-07 and S-08 as out of scope; S-05 is absent from both. It was
built on instruction, so everything below is my design and needs review.

### The first thing I did was stop writing code

MEES is law. Some of it is *proposed* law. Brief §4.4 already says not to encode
planning law in code, and that rule binds harder here, because a wrong constraint
flag is a wrong prompt while a wrong MEES flag is wrong advice about a legal duty.

So before writing any threshold I read the Focus Green `mees-advisory` skill and
its policy reference. **My training data was wrong**, and wrong in the direction
that would have shipped:

| | what I would have written from memory | the actual position |
|---|---|---|
| interim milestone | EPC C by 2027 | **dropped 18 June 2026**, will not be taken forward |
| headline target | EPC B by 2030 | EPC B by **2031** |
| who it applies to | all non-domestic | buildings **over 1,000 m² only** |
| status | in force | **proposed**, secondary legislation still required |

Every one of those four errors would have produced a confident, plausible, wrong
screening flag on a client's portfolio. This is the clearest argument yet for
brief §0 rule 2 — the deterministic-only rule — extending to policy: values that
decide a legal answer must come from a file, not from a model's recall.

### Everything is data, and none of it is approved

`mees_rules.yaml` holds the thresholds, the states and every sentence, sourced to
SI 2015/962 and the DESNZ interim response of 18 June 2026. All entries are
`approved: false`; `npm run site:verify` prints the count and the policy position
the file currently encodes, so a drift between the file and the law is visible
without reading the YAML. PRELAUNCH TICKET-09 carries the sign-off.

The dropped 2027 milestone is **kept in the file rather than deleted**, so the
system can state the negative. Anything written before June 2026 — a portfolio
plan, a competitor's report, a model's answer — may still assume that duty, and
"there is no EPC C requirement" is a more useful output than silence.

### What the screening refuses to say

No state says *compliant* or *non-compliant*, and a test enforces it across the
whole YAML. Three reasons, each a thing the system does not know:

1. **MEES binds a letting, not a building.** Tenure, lease length and lease terms
   decide whether it bites, and none of them are held here. So the wording is
   conditional throughout.
2. **The PRS Exemptions Register is not a dataset we have.** A building below
   EPC E with a registered exemption is lawfully let. Every below-minimum result
   says so — PRELAUNCH TICKET-10.
3. **The 2031 target is not law yet.** Stated on every result, not just the ones
   it bites.

These five standing caveats are assembled in one place rather than written into
each state's wording, so no single edit can drop one.

### The distinctions that took the design

**An asset rating is not an operational rating.** A DEC reports measured
performance on a different scale; MEES is assessed on the asset rating from a
non-domestic EPC. `currentCertificate()` falls back to any register when no
non-domestic certificate exists, so without a guard a DEC's band would have been
screened as if it were an EPC band. It now returns `not_supported` with no band
at all. A domestic certificate is refused the same way — different regulations.

**An expired certificate is not a low band.** It is the absence of a valid
certificate, checked *before* the band, because the band is not the finding.
Ten years from lodgement; inspection date is a fallback that can only make a
certificate look older, never newer.

**A band and a score can disagree.** Where the register publishes both, a
disagreement is reported and never resolved — same rule as the S-06 floor-area
divergence. (The Task 0 test fixture turned out to carry exactly this defect:
band C against a score of 58, which is band B. Corrected, and the case is now
tested deliberately.)

**Which gap is urgent depends on the band.** A building at F has a letting
problem *today*; its distance to a 2031 target is the lesser question. So the
result carries the distance to the minimum in force and to the proposed target,
separately. And both are given in BER points as well as whole bands, because a
one-band gap can be two points or forty-nine.

### The 1,000 m² threshold is the honest-failure case

The 2031 test is a **gross internal area of the demise**. What we have is an EPC
total floor area, or a VOA area on a stated basis (GIA/NIA/GEA/EFA) — different
measurements, none of them a measured GIA of a demise. So a figure near the line
cannot decide which regime applies, and the screening says so rather than
picking: within ±10% of 1,000 m² returns `area_indeterminate`. No area at all
returns the same, never "assumed small". Whichever area is used, its source
travels into the result and onto the screen.

### Fuel, and the one claim that must not be overstated

The non-domestic rating is a CO₂ rate. Rooftop PV displaces purchased
electricity, so on a gas-heated building it does not touch the emissions that set
the band. That is why `main_fuel` is now captured and classified.

This matters more here than in a generic EPC tool, because this module exists to
find PV sites. The flag therefore says exactly one thing and then says what it is
*not*: PV will not move the **band** on a gas building — which is not a view on
whether the roof is a good PV site for bill savings or Scope 2. Those are two
questions with two different answers, and collapsing them would mislead in both
directions. `pvCanMoveBand` is exposed as its own field so the PV workstream
consumes the narrow claim rather than re-deriving it.

### Band colour was saying the opposite of the text

The existing `.epc-band` scale colours E red alongside F and G. As a performance
scale that is defensible; in a MEES panel it contradicts the sentence above it,
because E *meets* the minimum in force and F and G do not. Inside `.perf` the
colours now follow MEES meaning — A+/A/B green, C/D/E amber, F/G red — and the
general scale elsewhere is untouched. A+ was missing from it entirely and has
been added.

### What was built

| file | role |
|---|---|
| `db/migrations/008_epc_performance.sql` | fuel, BER, TER, SER, primary energy, transaction type |
| `performance.ts` | leaf module: band scale, validity, fuel, intensity. No db, no fs |
| `mees_rules.yaml` | thresholds, states, flags, all sourced, all unapproved |
| `mees.ts` | screening; reads the YAML, returns states and rule keys |
| `service.ts` → `performanceFor()` | prefers the certificate carrying the site's UPRN over the newest in the postcode |
| `/api/site-intel/performance` | optional `area_m2` / `area_basis` for a measured GIA |
| `SitePanel` → `PerformancePanel` | finding, check, numbers, flags, then caveats |

One bug found by writing the panel: `reset()` cleared every other report but
would have left the previous building's MEES screening on screen after a new
search — a finding about a legal duty attached to the wrong building.

**47 tests**, 261 across the suite.

### Not done

- No live EPC call. Egress is blocked; the screening is verified against the
  cached sample row and constructed fixtures.
- The register's EPC recommendations endpoint is not wired, so no measure list
  or 7-year payback test. That is the `building-energy-audit` skill's territory
  and needs CAPEX inputs this module does not have.
- No lease data, so no trigger-year segmentation and no MEES tracker export.
  Both are in the Focus Green MEES workflow and both need tenure this system
  does not hold.
- Welsh divergence not considered. The rules file is marked England and Wales
  after the source, but nothing verifies the Welsh position separately.

## 2h. S-08 — the MEES prospect list

S-08 is one line in the brief's out-of-scope list (§10, "MEES prospect list").
It is also the thing I warned about in PRELAUNCH TICKET-10 when building S-05:

> "If a MEES prospect list (S-08) is ever built on top of this, the distinction
> stops being cosmetic: a list of 'non-compliant buildings' that is really a
> list of 'buildings whose exemption status is unknown' would be wrong in a way
> clients act on."

So the design starts from that, not from the feature.

### The corpus is the EPC register, not the VOA list

S-07 searches the VOA rating list and attaches an EPC band by postcode. That is
honest there — the band is a lead hanging off a search result. It is **not**
honest here. A prospect list names a building and states its band, so a
postcode-matched band would put a specific address on a list of poorly-rated
stock because its neighbour is poorly rated.

The register does not need the join. A certificate carries the address, the
floor area, the fuel and the band **in one record**, so the claim the list makes
is sourced from a single row. VOA use class and rateable value stay available as
enrichment at address-match quality (S-06's T3), and are not part of the
screening.

This is the first section where the awkward source turned out to be the right
one: everything since S-04 has been working around a paywalled identifier, and
here the free source is the authoritative one.

### One row per building, not per certificate

The register holds **every certificate ever lodged**. A building re-assessed
from F in 2015 to B in 2024 has two. Listing both would put it in the
below-minimum cohort *and* the meets-target cohort, inflate every count, and
send someone to an owner about a band superseded years ago.

The first live run surfaced exactly this: 11 certificates, 10 buildings. Only
the most recent certificate per building is screened, and the rest are **counted
and reported**, not quietly dropped — the coverage statement says how many were
set aside.

Identity is `COALESCE(uprn, building_reference, lower(address) || '|' ||
postcode)`. The fallback is the weakest link: two spellings of one address still
produce two rows. That is the safe direction to fail — a visible duplicate beats
an invisible wrong merge.

### Coverage is the loaded cache, not the country

`epc_certificate` is filled per postcode by lookups. Until now that made a
prospect list impossible in principle: it could only cover postcodes somebody
had already searched. So `npm run epc:load` was added for the register's bulk
downloads, and the coverage statement sits **above** the results on the page and
in the first rows of any export:

> "This list covers the 11 non-domestic certificates currently loaded, across 5
> postcode districts. That is what has been fetched or bulk-loaded, not the
> national register: a count here is a count of what is held, never a count of
> what exists."

"Four F-rated buildings in DN4" and "there are four F-rated buildings in DN4"
are different claims. Only the first is ever true here.

### Cohorts, and why there is no score

A single prospect score blending band, area, fuel and expiry would rank
buildings by a weighting nobody chose and no source supports — and it would be
read as a measurement. Instead there are seven named cohorts, each carrying its
own criteria and its own reason, and ordering is by explicit columns.

| cohort | criteria |
|---|---|
| Below the minimum band | F or G on the most recent valid certificate |
| Certificate expired | more than ten years since lodgement |
| Inside the proposed 2031 horizon | C/D/E, clearly above 1,000 m² |
| Regime cannot be determined | C/D/E, area unknown or within 10% of the threshold |
| Meets the minimum, no further target | C/D/E, clearly at or below 1,000 m² |
| Meets the proposed 2031 target | A+, A or B |
| Could not be screened | no readable band |

Cohort membership is decided by S-05's `screenMees`, **not by SQL**, so the
policy lives in exactly one file and a legislative change lands in one place.
A test asserts every screening state maps to a cohort, so a new state in S-05
cannot make buildings silently vanish from the list.

### Three things put where they cannot be trimmed

1. **The exemption caveat is on the row**, not only in the cohort note and not
   only on the page. The below-minimum row is the one a reader treats as an
   enforcement list and the one most likely to be screenshotted on its own.
2. **An expired certificate's band is labelled "last known".** The badge alone
   reads as current, and a 2015 G rating says what the building was eleven
   years ago. Caught in the browser, not in a test.
3. **The export carries its caveats as visible rows.** A spreadsheet is the
   dangerous artefact — once the list is in Excel it travels without the page
   around it. Every row also carries its own status sentence and an explicit
   `exemption_status_unknown` column, so a row read alone still says what it is.

### Two smaller things worth recording

**CSV formula injection.** A cell beginning `=`, `+`, `-` or `@` is executed as
a formula by Excel and Sheets. These cells carry addresses and free text from an
external register, so they are prefixed with an apostrophe.

**The benchmark is context, not a threshold.** KFIM's 2025 figures (73.38% at B
or above) are in the rules file with their citation and the skill's own caution:
an actively managed institutional portfolio is not a like-for-like comparison
with the general stock of an area. It answers "is this area unusual?", which is
a prospecting question, and nothing else.

### One design flaw found and fixed

`epc-load.ts` calls `main()` at the top level, so importing its CSV parser for a
test started a bulk load and exited the process. The parser moved to
`src/ingest/csv.ts`, a leaf module — the third time this pattern has been needed
(`area-basis.ts`, `search-describe.ts`), and worth treating as the default for
anything a test or a client component might want.

### What was built

| file | role |
|---|---|
| `db/migrations/009_mees_prospects.sql` | partial indexes on the non-domestic corpus, `epc_bulk_load` |
| `prospects.ts` | cohorts, dedupe, coverage, summary; re-uses `screenMees` |
| `src/ingest/epc-load.ts` | bulk loader, columns read by name |
| `src/ingest/csv.ts` | RFC 4180 line parsing, leaf module |
| `/api/site-intel/prospects` | filters, JSON and CSV |
| `/land/mees` + `MeesProspects.tsx` | coverage first, then cohorts, then rows |

**15 tests**, 276 across the suite.

### Not done

- **No lease data**, so no trigger-year segmentation and no earliest-termination
  column. That is the spine of the Focus Green MEES tracker workflow and it
  needs tenure this system does not hold. The list is a prospecting tool, not a
  portfolio tracker, and should not be presented as one.
- **No .xlsx tracker export.** CSV only. The Patrizia V8 workbook has summary,
  per-year and 2031 tabs; producing it is a separate piece of work.
- **No EPC recommendations**, so no measure list and no 7-year payback test.
- **The bulk loader has never seen a real file.** Egress is blocked. Columns are
  read by name against the published schema, missing ones are reported, and the
  first parsed record is printed for checking.
- **`fixtures/epc-certificates.sample.csv` is invented**, like the substations
  sample. Every row is prefixed `SAMPLE-`. It is not register data.

## 2i. S-03 completion — grid capacity

S-03 is the one section with a real specification (brief §5), and the only one
partly built before the brief arrived. §2 above records what existed: the schema,
the Opendatasoft client, the registry, the normaliser and the map. This is what
§5 asked for and what was missing.

### §5.1 — "which DNO" was answering a different question

The DNO came from whichever substation happened to be nearest. That is not the
same question. Licence areas are administrative boundaries; a site near one can
easily have its nearest substation on the other side of it, and the answer feeds
a connection enquiry.

Now: point-in-polygon against the NESO DNO licence-area boundaries, with the
version date stored, because a boundary that moved is a different answer.

Three decisions inside it:

- **Ray-cast in TypeScript, not PostGIS.** There are ~14 licence areas. PostGIS
  stays optional (migration 004), and a cast over fourteen polygons is
  microseconds. `geo-polygon.ts` is a leaf module so the map can use it too.
- **Holes are honoured.** A GeoJSON polygon is an outer ring plus holes, and a
  licence area can enclose another. A point in a hole is *outside*, because
  reporting the enclosing DNO would be a wrong answer rather than a missing one.
- **An unmatched area is stored with a null `dno_id` and reported**, never
  guessed. `matchDno` maps NESO's area names onto our registry ids by pattern;
  anything unrecognised returns null and the loader prints it. A wrong DNO on a
  connection enquiry is worse than none.

The first live run then found a fourth case I had not handled: **two polygons
containing the same point**. The code returned whichever row the query happened
to yield first — a coin toss answering "which DNO". It now collects every
containing area and, where there is more than one, says so in the method text
and downgrades the state to `proximity`.

### §5.2 — the adapter interface, and NGED

`adapters/base.ts` is the brief's `DnoAdapter` Protocol in TypeScript, shaped
identically so a port to Python is mechanical (TICKET-08 still open).

The rule the interface encodes: **`null` means "this DNO does not publish it"
and an empty array means "published, and there is nothing here."** Callers must
be able to tell those apart — it is the difference between `not_supported` and
`not_found_coverage_complete`.

`adapters/ckan.ts` covers NGED, which the brief puts first in the build order and
which the original ingest could not touch because it publishes through CKAN
rather than Opendatasoft. The shape difference that matters: CKAN serves a
*package of resources*, so a pull is read-package → choose-resource → fetch, and
choosing is the step that fails silently. A package carries PDFs and dashboards
alongside the data, so `chooseResource` takes the most recent CSV and the choice
is always reported rather than assumed.

Two helpers that are deliberately conservative:

- `levelFromVoltage` returns **null in the overlapping ranges** rather than
  picking. A level is a network role and voltage is only a proxy, so a derived
  level is always recorded as `derived_from_voltage` and never shown as the
  publisher's word.
- `normaliseEcrStatus` matches the **participle, not the stem**. "Accepted to
  Connect" contains "connect" and means the opposite of connected — it is an
  offer, not an energised generator. A stem match put generation on the network
  that is not there yet, which understates the headroom a screen would find. The
  test suite carries that case.

### §5.4 — the logic, and what stays unrated

All thresholds are in `grid_rules.yaml`, all unapproved, as §5.4 requires.

1. **A containing supply-area polygon wins; otherwise the nearest N,
   `nearest_by_distance`.** The label travels into the output and onto the
   screen, with the sentence explaining that proximity does not mean a
   substation would serve the site.
2. **ECR within 2 km at 50 kW export and above**, summarised by technology *and*
   by status. An entry whose technology did not map gets its own `unknown`
   bucket rather than being folded into a named one — it is not evidence about
   solar or wind.
3. **`unrated` is a fourth state, not a missing green.** Both screens stay
   unrated until something supplies their input, and the wording says "an
   absence of assessment and not a favourable result". Collapsing unrated into
   green is the single most dangerous simplification available here, because a
   screen is read as a permission. A test asserts the explanation contains no
   reassuring word.
4. **The fixed caveat is rendered last and unconditionally** — not collapsible,
   not optional, straight from the YAML.
5. **Staleness is measured against the DNO's published date**, falling back to
   our ingest date only when the publisher states none. Fetching old data today
   does not make it fresh, and `basis` records which date was used.

One more distinction the panel makes: **whose RAG is it.** Where the DNO
publishes its own rating the ingest keeps it; where it does not, ours is used
and the row says "RAG is our screening band, not the DNO's".

### The G98/G99 figures are deliberately null

§5.4 says "Any G98/G99 or other threshold values live in config and are signed
off by James." They are in config — as `null`, marked `verified: false`, with a
source line saying PLACEHOLDER.

They are not in the brief, not in the `solar-pv-design` skill (which covers G99
*applications* and G100 export limitation, not the threshold values), and writing
a connection threshold from memory is how you ship a wrong answer about someone's
grid application — the MEES lesson from S-05, one section later. Null fails
loudly. Nothing currently reads them, because the PV export screen is unrated
until a PV design module supplies a kWac figure, so no output depends on them
today. A test asserts they stay null.

### A bug that would have broken most of the country

The API route reused one "non-negative number" validator for capacities *and*
coordinates. **Most of Great Britain has a negative longitude**, so every site
west of Greenwich became `NaN`, and the point-in-polygon then reported "no DNO
contains this point" — a confident wrong answer rather than an error.

It surfaced on the first end-to-end run against Doncaster and took a while to
find precisely because both the SQL and the geometry were correct in isolation.
Separate validators now, and a test asserting the two shapes differ.

### A third CLI-on-import bug, fixed as a class

Importing `matchDno` from `dno-boundaries.ts` for a test printed a usage message
and exited the runner — the same failure as `epc-load.ts` in S-08. Rather than
extracting a third leaf module, `src/ingest/cli.ts` provides
`isEntryPoint(import.meta.url)` and the loaders' `main()` calls are wrapped in
it. Helpers stay importable and the class of bug is closed.

### What was built

| file | role |
|---|---|
| `db/migrations/010_grid_s03.sql` | `dno_licence_area`; substation `level`/`source_date`/`area_geom`; ECR `technology`/`status` |
| `lib/geo-polygon.ts` | ray cast, holes, bbox, haversine, latitude-aware radius box |
| `site-intel/grid_rules.yaml` | every threshold and sentence, all unapproved |
| `site-intel/grid-screen.ts` | RAG, freshness, screens, ECR summary, fixed wording |
| `site-intel/grid.ts` | §5.1 and §5.4 end to end for a site |
| `ingest/adapters/base.ts` | the brief's `DnoAdapter`, plus level and status normalisation |
| `ingest/adapters/ckan.ts` | NGED |
| `ingest/dno-boundaries.ts` | NESO GeoJSON loader |
| `ingest/cli.ts` | entry-point guard |
| `/api/site-intel/grid` + `GridPanel` | §5.5 profile panel |

**46 tests**, 322 across the suite.

### Not done

- **§5.5 map layers.** The substation layer exists and is RAG-coloured. The
  supply-area polygon layer and ECR-by-technology layer are not drawn; the data
  and the containment test are both in place for them.
- **No live DNO call, still.** Every portal returns 403 from the egress proxy.
  `grid:verify` reports 0 reachable, 12 failed — which is the honest state, and
  the reason the CKAN field mapping is a proposal rather than a fact.
- **The five Opendatasoft DNOs still use the original ingest path**, not the new
  adapter interface. The interface is defined and CKAN implements it; wiring the
  ODS DNOs through it is mechanical and was not done here.
- **`fixtures/dno-licence-areas.sample.geojson` is invented**, three boxes over
  Yorkshire. Every feature is prefixed `SAMPLE-`. It exercises the containment,
  the unmatched-area path and the overlap path; it is not NESO data.

## 2j. S-02 map layers

S-02's screening and panel were built earlier (§2c). The constraints were never
drawn. This puts them on the map.

### A map is the worst surface for a bare absence

Brief §0 rule 4 says the system must never report "no constraints", and a result
where nothing was found must say whether coverage was complete. The panel
already does that — an empty list prompts "did it look?".

**A map that draws nothing just looks like open country.** There is no empty
list to interrogate; the absence of polygons reads as an all-clear. So the
layers are inseparable from a coverage strip that states, above the toggles:

> "2 drawn on the site, 3 nearby · 1 flagged but published no extent to draw —
> 15 COULD NOT BE CHECKED, so an empty map is not an all-clear."

It takes the risk treatment whenever anything was not established, and the
datasets behind that number are named underneath. On the sample site that is 15
of 21, because nothing sets `not_found_coverage_complete`: planning.data's
per-LPA provision endpoints are not consulted (§2c), so every dataset that
returns nothing stays `coverage_unknown`. The map now makes that visible rather
than leaving it to the bottom of a list.

### Present and proximity are separate layers, not one styled by a property

A proximity polygon drawn like a present one says the site is *inside* a
conservation area when it is merely near one. That is the single most misleading
thing this map could do, so:

| | fill | outline |
|---|---|---|
| on the site | 0.3 | solid, 2px |
| nearby | 0.1 | **dashed**, 1.5px |

Separate sources also make the toggles independent, and the popup says it in
words — "Near this site — the site is NOT inside it" — because a dash pattern is
not enough to carry that to someone who has just clicked a shape.

### Three things the map now admits

1. **The search envelope is drawn.** It is a *bounding box* around the site
   geometry, not a true buffer, so its corners reach further than the stated 50 m.
   Showing it beats letting the reader picture a neat circle, and the legend says
   so in as many words.
2. **A flag whose source published no extent is counted separately.** The
   constraint is real and in the panel; there is simply nothing to draw. Silently
   omitting it would understate the site, so the strip says "1 flagged but
   published no extent to draw".
3. **Hiding a layer does not change the coverage line.** The toggles filter the
   layers; the counts describe what was screened. Turning off Heritage must not
   make the map claim heritage was not checked.

### Two bugs the browser found that tests would not have

**Constraint fills drew over the building.** The layers were added after the S-01
site layers, so a green belt fill — which covers the whole viewport at building
zoom — sat on top of the footprint and the title extent. Moved before them.

**Popups opened underneath the legend.** A constraint in the right-hand half of
the map produced a popup the legend covered, swallowing both its text and its
close button. `.maplibregl-popup` now has a z-index above both legends.

Neither is reachable from a unit test. Both were obvious within seconds of
looking at the rendered page.

### One design decision reversed mid-build

The first version registered a click handler per layer. It looked simpler and
was wrong: a green belt covers the viewport, so its fill wins the hit test and a
click aimed at the flood zone underneath returned the green belt. **The smaller,
more specific constraint — the one a reader clicked to find out about — became
unreachable.**

Replaced with a single handler using `queryRenderedFeatures` across both layers,
listing every constraint at the point, `present` first. The sample site returns
three in one popup.

### Framing

`showSite()` flies to zoom 18, which is right for "is this the building?" and
wrong the moment constraints are drawn — a designation becomes a colour wash
rather than a boundary. When constraints load the map fits the **search
envelope**: the area actually screened, already drawn, with anything beyond it
genuinely off-screen rather than omitted.

### What was built

| file | role |
|---|---|
| `site-intel/constraint-layers.ts` | categories, colours, coverage summary. Leaf module, no I/O |
| `constraints.ts` | entities now carry their geometry; the screening reports its search area |
| `LandMap.tsx` | three layers, category toggles, coverage strip, multi-constraint popup |
| `SitePanel.tsx` | `showConstraints` on the map API |
| `fixtures/planning-data-stub.mjs` | invented stub, so this is reproducible without egress |

The category map is **presentational and lives in TypeScript, not the YAML**.
`constraint_rules.yaml` holds the wording James signs off; padding it with colour
choices would blur what the sign-off covers. A test asserts every dataset with a
rule has an explicit category, so a new constraint cannot fall silently into
"other" and be drawn in a colour that means nothing.

**12 tests**, 334 across the suite.

### Not done

- **No live planning.data call.** Still 403 from the egress proxy. Verified
  against `npm run planning:stub`, which is invented data.
- **The UPRN search path cannot produce a screenable geometry here.**
  `queryGeometry` needs a footprint or exactly one title extent; the footprint
  store needs PostGIS and OS OpenMap Local, neither loaded. The browser check
  redirected the profile request to the stored profile, which has a footprint.
  This is a real gap in the demo path, not in the layer code.
- **No clustering or paging.** A portfolio run drawing thousands of polygons is
  not this; §2c already routes over 50 buildings to bulk downloads.
- **S-03's map layers are still not drawn** (supply-area polygon, ECR by
  technology). The pattern here ports directly to them.

## 2k. S-03 map layers

Brief §5.5 asks for three: substations coloured by RAG (already there), the
**supply-area polygon**, and **ECR generators by technology**. This adds the two
missing ones, plus a ring marking which substations the screening actually used.

### The reading this layer must not invite

An Embedded Capacity Register entry is generation **already connected or
accepted**. Drawn as dots around a site it invites two wrong readings:

- "there is capacity here" — it is closer to the opposite; the register records
  what the network has *absorbed*
- "others got connected, so I can" — a queue position is not a precedent

So `ECR_MEANING` is a single exported sentence, it appears in the legend with
the warning treatment, and it repeats inside **every** ECR popup. It is the only
string in this module that is duplicated on purpose.

### Connected and accepted are drawn differently

Same rule as `present` and `proximity` in S-02, for the same reason: an accepted
connection **is not generating yet**, and showing the two alike states something
false about the network as it stands today.

| | fill |
|---|---|
| connected | 0.75 |
| accepted | **0.18** (hollow) |
| status not stated | 0.35 |

Dot radius scales with export capacity, because a 40 MVA wind farm and a 60 kW
rooftop array are different facts about the network and equal dots would deny it.

### Two things deliberately not drawn

**The DNO licence-area boundary.** It is county-sized and the map frames a
building, so it would be an edge-to-edge wash carrying no information. The panel
states which area the site is in, and the overlap case, in words.

**A "capacity available" layer.** There is no such figure in this data. Headroom
is a substation attribute, already on the rings and in the panel.

### The counter that could never fire

The first version derived "features with no coordinates" from the returned
lists. That number is **structurally always zero**: a radius query filters on
coordinates, so an entry without them can never appear in the result to be
counted. Shipping a counter that cannot fire is worse than not having one — it
reads as a checked-and-clear.

It now comes from a separate count, scoped to the DNO: *"1 register entry for
this DNO published no coordinates and cannot be placed"*. That is a real
coverage gap — those entries are invisible to every radius search — and it is
the direct analogue of S-02's "flagged but published no extent to draw".

### One frame cannot serve both layer sets

S-02 fits the map to the constraint search envelope, about 50 m across. The ECR
radius is 2 km. Fitting the wider one makes the building a dot and the
constraints invisible; fitting the tighter one puts most register entries
off-screen, where their absence reads as "none nearby".

The site fit wins, and the grid legend carries a **"Zoom to the 3 register
entries — most sit outside this view"** button. Saying they are outside the view
and offering to go there beats either bad frame.

### Legends

Two legends plus the headroom key filled the right-hand side. Both now collapse
their swatches behind a `Key` summary, and S-02's not-established list behind its
own. What stays visible is the honesty-critical part: each coverage line, and
for S-03 what a register entry means. Reference material can be asked for; a
caveat cannot.

### One bug found in the browser

The constraint click handler is map-level, so clicking an ECR dot inside a green
belt opened **two** popups — the specific thing the reader aimed at, and the area
they happened to be standing in. The handler now defers when a point layer is
under the cursor. Verified: clicking a dot opens exactly one popup, and it is the
dot's.

### What was built

| file | role |
|---|---|
| `site-intel/grid-layers.ts` | technologies, statuses, `ECR_MEANING`, coverage. Leaf module |
| `site-intel/grid.ts` | substations now carry `areaGeom`; profile carries `placement` counts |
| `LandMap.tsx` | supply-area, ECR and site-substation layers, popups, legend, zoom action |
| `SitePanel.tsx` | `showGrid` on the map API |

**16 tests**, 350 across the suite.

### Not done

- **No live DNO or register call.** Verified against the invented sample rows
  seeded in the dev database; every one is prefixed `SAMPLE-`.
- **No clustering.** A dense urban ECR area will overplot. The register is
  radius-limited to 2 km so the counts stay small, but a city-centre site will
  look crowded.
- **The supply-area polygon is rarely populated.** Most portals publish headroom
  as points; the sample data carries one so the layer is exercised. When absent
  the substation method falls back to `nearest_by_distance` and both the panel
  and the map legend say so.
## 2l. S-01 footprint store

### I was wrong, and it cost four sections

The old comment in `stores.ts` read:

> "Building footprints from OS OpenMap Local. **Genuinely needs PostGIS** —
> polygon containment and intersection are not things to hand-roll over a whole
> national dataset."

Wrong on every clause.

**Containment was already hand-rolled**, in `geo.ts`, since S-01 — `pointInPolygon`
has been sitting there the whole time. **Intersection** is an orientation test
over edges; it is about sixty lines and exact for simple polygons. And **"over a
whole national dataset"** was the real error: nothing scans the dataset. A
bounding-box lookup on an index returns a handful of candidates and the exact
test runs over those. A building carries tens of vertices.

The consequence was not theoretical. PostGIS was never installed here — the
install was declined early on — so the store returned `undefined`, so every
profile reported `footprint: unavailable`, so `queryGeometry` had nothing to
screen, so **S-02 could not run at all from the UPRN search path**. I worked
around that twice in browser checks by redirecting the request to a stored
profile, and wrote it up both times as a gap in the demo path. It was not a gap
in the demo path. It was a dependency that was never needed, blocking the chain.

The brief does say PostGIS (§3.2). This deviates, for the reason migration 004
already established: PostGIS stays optional so the app runs on plain Postgres.
If it is ever installed, `ST_Contains` over a GIST index is faster. It is not
required, and saying it was is what did the damage.

### The store

Two methods, both bbox-filter-then-exact-test:

- **`containing(point)`** — bbox window in SQL, ray cast in TypeScript, ordered
  by area **ascending** so the *smallest* containing polygon wins. That matters
  where a unit sits inside a larger terrace outline: the unit is the answer.
- **`largestIntersecting(geometry)`** — bbox overlap in SQL, ordered by area
  **descending**, exact edge test in TypeScript, first hit returned. Area is
  precomputed at load, because recomputing it per query would mean parsing every
  candidate.

`polygonsIntersect` is exact for simple polygons: an edge of one crossing an
edge of the other, or a vertex of either lying inside the other. The edge test
runs first because it is the common case and the cheapest to fail.

### The epsilon is not a fudge

The first version compared cross products to exactly zero. Two buildings sharing
a **party wall** then came out as not intersecting — because `-1.12 + 0.001` is
`-1.1190000000000002`, not `-1.119`, and an exact test decides that knife edge
by rounding error.

Fixed by normalising each cross product by its segment length, so the tolerance
means a *perpendicular distance* rather than an area — a raw cross product
scales with polygon size, so a fixed epsilon against it would be strict for
small polygons and loose for large ones. The tolerance is 1e-12 degrees, about
1e-7 m: far below any survey tolerance, far above float noise.

Touching counts as intersecting, which is also what `ST_Intersects` says — so
the non-PostGIS path gives the same answer the PostGIS path would.

### The projection trap

OS publishes OpenMap Local in **British National Grid (EPSG:27700)**, whose
coordinates are metres — eastings around 400000. Everything downstream expects
WGS84.

A BNG file loaded unconverted **does not error**. It produces polygons at
longitude 400000, which fall outside every bbox query and silently match
nothing: the store would look loaded and answer null to everything. So the
loader range-checks coordinates and **stops on the first bad feature** with the
fix in the message — a partial import of misplaced polygons is worse than none,
because they match nothing and nothing says why.

It refuses two different ways, with different reasons: out-of-range magnitudes
("this looks like British National Grid"), and valid lat/lng outside the British
Isles ("check the file and its projection" — a building in Barcelona in a UK
dataset is the wrong file, not the wrong projection).

No datum shift is attempted here. OSTN15 is a grid transformation, not a
formula, and an approximate one would move buildings by metres. `ogr2ogr` does
it properly and the message says so.

### Reading the file

Streamed line by line, not `JSON.parse`d whole: a single local-authority extract
runs to hundreds of MB and the parse would exhaust memory before the first
insert. Per-line features are the common export shape; a single-line
FeatureCollection falls back to a whole-file parse.

### The chain finally runs

First time end to end from a bare UPRN, no redirect:

```
footprint method : uprn_contained · 4,044 m²
constraint basis : footprint        (was null)
constraint states: 3 present, 3 proximity, 15 coverage-unknown
```

The address is populated too, because the EPC register supplies it — so S-01,
S-02, S-03, S-05 and S-06 all now run from one search box.

`npm run site:verify` reports the polygon count, and when it is zero says
plainly what that costs: *"no footprints, so every profile reports footprint:
unavailable and S-02 has no geometry to screen"*.

### Also

`site_profile` gained `footprint_original`, `footprint_original_method` and
`footprint_overridden_at`. Brief §3.2 asks for a user redraw stored as an
override tier **keeping the original** — an override that destroys what the
source published cannot be undone, and the original's provenance is what makes
the override reviewable. The columns exist; the redraw UI does not (below).

### What was built

| file | role |
|---|---|
| `db/migrations/011_footprints.sql` | `os_building` with bbox index, override columns, `building_load` |
| `geo.ts` | `polygonsIntersect` with a length-normalised tolerance |
| `stores.ts` | the store, no PostGIS; `buildingCount` |
| `ingest/buildings-load.ts` | streaming loader with the projection guard |
| `fixtures/os-buildings.sample.geojson` | 29 invented polygons, all `SAMPLE-BLD-*` |

**17 tests**, 367 across the suite.

### Not done

- **No real OS OpenMap Local file has been loaded.** Egress is blocked. The
  loader is verified against an invented fixture and against a synthetic BNG
  file that it correctly refuses.
- **No redraw UI.** The columns are there; the map has no draw tool, so
  `user_drawn` is still unreachable and `footprint_overridden_at` is always null.
- **Title extents are still empty**, so the `title_intersect` fallback cannot
  trigger from the UI — `title-boundary` reports `coverage unknown`. The method
  is tested directly and works; it has no data to work on.
- **No spatial index beyond the bbox btree.** Fine at this scale. A national
  load would want either PostGIS or a coarse grid key.
## 2m. S-01 redraw

Brief §3.2: *"Users can redraw the footprint on the map. Store that as an
override tier and keep the original."* §3.4 asks for the control beside Confirm.

The PATCH route already accepted a `footprint` and `applyOverride` already set
`user_drawn` at T4. Two things were missing: the original was **discarded**, and
there was no way to draw one.

### Keeping the original, and only the original

Migration 011 added `footprint_original`, `footprint_original_method` and
`footprint_overridden_at`. Nothing wrote them. Now the first override captures
what the source published, and a **second redraw replaces the drawing, never the
original**.

That distinction is the whole point. If each redraw overwrote the stored
original, "revert to the OS polygon" would quietly become "revert to my last
shape" — the button would still be there, still work, and no longer do what it
says.

Reverting also restores `footprint_inferred` when the original carried it.
That flag described the *source* polygon's provenance — it was found by
intersecting a title extent, not by containing the UPRN. Dropping it while a
drawing is in force is right; failing to bring it back would make the restored
polygon look better sourced than it is.

### The drawing tool is hand-rolled

No draw library. This map has already burned two dependencies — MapLibre v4's
XSS in the popup sanitiser, and the v6 worker that never loaded — and a
polygon-by-clicks tool is about eighty lines. Fewer moving parts beats fewer
lines here.

Click to place a vertex, Undo point, Cancel, Save. Below three points the line
layer draws a **LineString, not a closed polygon**: showing a closed shape with
two points would misrepresent what has been placed. Save is disabled below three,
and `finishDraw()` checks again — a two-point "polygon" would be stored as a
footprint with no area.

Draw state lives in refs, not React state: the map's click handler binds once on
load and would otherwise close over a stale snapshot. The panel learns the vertex
count through a callback.

The draw handler is registered **first**, and every other click handler bails
while drawing. Without that, a click placing a corner would also open a
constraint popup over the shape being drawn.

### The stale-screening problem

S-02 screens against the footprint. Redraw it and the constraints on screen were
computed for a **different shape** — findings for one polygon, attached to
another on the map.

The panel now says so, above the constraint list, and offers to re-screen. It
does **not** re-screen automatically: a redraw is usually followed by another,
and each automatic re-run is a round of calls to planning.data. Saying the
results are stale is both cheaper and more honest than silently refreshing.

### Saying it is a drawing

A user polygon is T4, and its area feeds the constraint screen and anything
reading floor area. So the figure itself carries a **"your drawing"** badge — not
just a line in the lineage list — and the panel states the published area, the
method it came from, and how much bigger or smaller the drawing is:

> Your shape is 66% smaller. Anything computed from floor area uses this figure now.

### A layout bug the tool exposed

The panel grew a section per slice — facts, states, constraints, EPC,
performance, grid, ownership, VOA — and nothing bounded its height. It pushed the
page past `100dvh`, the **document** scrolled, and the map went with it.

Invisible until the redraw tool needed the map on screen: draw mode engaged, the
cursor turned to a crosshair, and there was nothing visible to click. The panel
now scrolls itself. `min-height: 0` is the load-bearing half — without it a flex
item refuses to shrink below its content and `overflow-y` never engages.

This had been broken for several slices and no screenshot caught it, because
every previous browser check drove the panel from the top.

### Move pin

Brief §3.4 lists it beside Confirm and Redraw, and §3.1 step (e) says what it
means: a map click resolves to the **nearest OS Open UPRN within 25 m**.

That distinction decided the implementation. `applyOverride` already accepts a
`point` and stores it directly at T4 — and the UI deliberately **does not use
it**. Storing a raw click would put a coordinate on the profile that no register
published, and leave the stored lat/lon disagreeing with the stored UPRN. So
Move pin re-runs the resolution chain instead: the click is a *pointer*, and
what gets stored comes from OS Open UPRN.

Three consequences, all visible:

- **Beyond 25 m nothing changes**, and the reason says so: "No OS Open UPRN
  within 25 m of that point." Silently keeping the old pin would leave the user
  believing the move worked.
- **A different UPRN is a different building.** Everything hanging off the old
  one — constraints, EPC, ownership, VOA, grid — is cleared, because `choose`
  already resets it. Leaving a constraint screening from the previous building
  attached to a new one would be the S-02 stale-footprint problem again, worse.
- **More than one UPRN within 25 m offers both**, nearest first with distances,
  rather than picking. On the sample data a click between two registered
  addresses returns 4.2 m and 8.8 m and waits.

The mode is **one-shot**: a mode that stays armed invites a second click that
silently re-resolves the site after the user thought they were done. Move pin
and Redraw are mutually exclusive — one click cannot mean both "place a corner"
and "pick a building" — and each disarms the other.

The PATCH endpoint still accepts `lat`/`lon` for a raw-point override. It is a
legitimate T4 capability and it is tested; it simply is not what the button
does. If a "nudge the pin within this building" control is ever wanted, that is
the path, and it needs its own wording because the coordinate would then be the
user's, not OS's.

Verified in the browser: armed hint and crosshair, Redraw blocked while armed,
cancel restores the cursor, a click 180 m out refused with the radius named and
the UPRN unchanged, a click between two addresses offering both.

### What was built

| file | role |
|---|---|
| `types.ts` | `FootprintOriginal` on the profile |
| `profile.ts` | capture-once, revert, flag handling in `applyOverride` |
| `service.ts` | the original round-trips through `site_profile` |
| `LandMap.tsx` | draw layers, `startDraw` / `undoDrawPoint` / `cancelDraw` / `finishDraw`, `startPick` / `cancelPick` |
| `SitePanel.tsx` | the controls, the override note, the stale-screening warning, Move pin |
| `globals.css` | the panel scroll fix |

**14 tests**, 381 across the suite.

### Not done

- **No vertex editing.** Points are placed and undone in order; an existing
  shape cannot be nudged. Redrawing from scratch is the only edit. *(Done in
  §2n.)*
- **No snapping** to the source polygon or to other buildings. *(Done in §2n,
  to neighbours only — see there for why not to its own vertices.)*
- **The override is not re-screened automatically**, by design (above) — but
  nothing forces the user to press the button, so a stale screening can be left
  on screen. It is labelled the whole time it is stale.
## 2n. S-01 vertex editing and snapping

§2m left two things undone and named them: an existing shape could not be
nudged, and nothing lined up with anything. Both are the same complaint from a
user — the published polygon is *nearly* right.

### Edit is the common case, so it comes first

Redraw assumes the shape is wrong. Usually it is right except for one corner,
and redrawing to fix one corner throws away four good ones and replaces them
with four hand-placed approximations. **Edit shape** seeds the editor from the
existing footprint and sits before Redraw in the button row.

It produces the same T4 override. A footprint with a moved corner is not what
OS published, and the tier has to say that whether the change was one vertex or
all of them.

`outerRing()` drops the ring's closing duplicate before editing. Keeping it
would put a handle on top of another handle, and dragging the twin away would
silently unclose the ring — a polygon whose last point is no longer its first.
For a MultiPolygon it takes the **largest part by vertex count** and drops the
rest, which is the only defensible default; holes and outbuildings are lost
rather than silently merged into the outline.

### The handles say what they accept

A solid handle is a vertex; a hollow, smaller one is a midpoint — a place a
vertex *could* go. They take different cursors, `move` and `copy`.

That started as a nicety and turned out to be the fix for a real defect: the
first version showed `move` over both, which promises a drag that the midpoint
does not accept. Found by reading the cursor in the browser, not by a test.

Midpoints appear only at three points or more. Below that there is no shape to
insert into.

### Gestures that had to be taken away

Three controls were wrong in edit mode and each had to be removed rather than
left to misbehave:

- **A click on open map must not append.** In a fresh drawing a click places
  the next corner. On an existing ring, tacking a corner onto the end is never
  what a click in the middle of the map meant — it would throw a spike across
  the shape. `appendOnClick` is false in edit mode; vertices go in through the
  midpoint handles.
- **Undo point is hidden in edit mode.** There is nothing of the user's to
  undo. The button would chop the last corner off the published ring under a
  label saying otherwise.
- **A click on a corner already placed grabs it**, rather than adding another
  on top. Closing a polygon by clicking its first point is a common instinct —
  in most draw tools it is how you finish — and without the guard it left a
  coincident duplicate that nothing would show.

`removeVertex` refuses below three and returns the list **unchanged rather
than throwing**: the caller is a pointer handler, and the right behaviour when
a delete would destroy the polygon is for nothing to happen. But nothing
happening is indistinguishable from a missed click, so at exactly three points
the panel says the removal is refused and why.

The hint names which mode is running, because the two accept different gestures
and a hint that described only one would be wrong half the time.

### Snapping is in screen pixels, not metres

This is the decision the module is built around. A tolerance in metres is
generous when zoomed out and unusably tight when zoomed in: the same 2 m would
take the wrong building at one zoom and refuse to snap at all at another. What
the user is doing is "put this handle on that corner", which is a screen-space
judgement, so the threshold is one — 12 px, at whatever zoom is in force. The
map supplies the projection; `draw.ts` never knows about zoom.

### Not its own vertices

The obvious candidate set is "every vertex on the map, including this shape's".
It is wrong. Dragging a corner onto the one beside it collapses the edge
between them into nothing, and the gesture that triggers it — nudging a corner
a short distance — is the commonest there is.

It also buys nothing. The site's own published footprint is in the neighbour
list already, because it is a building like any other, so "snap back to where
OS put it" still works — through the neighbours, where it cannot destroy an
edge.

### Snapping does not change provenance

A snapped vertex takes the neighbour's **exact coordinate**. That is the point:
shared party walls line up instead of disagreeing by half a metre, and the
epsilon in `polygonsIntersect` (§2l) stops having to paper over it.

It does not make the result source data. A shape built entirely from OS
vertices is still a user drawing at T4, because the user chose which vertices
and in what order. The panel states this under the checkbox rather than leaving
it to be inferred:

> A snapped corner takes the neighbour's exact coordinate. That does not make
> the shape source data — it is still your drawing.

The snapped target is **ringed in blue while the snap holds**. A handle that
jumps to a coordinate the user did not choose, with no explanation, reads as a
bug.

### Neighbours, and saying when there are none

`buildingsNear()` bbox-filters `os_building` then measures haversine distance to
each polygon's **own centre** — not the bbox corner, which would call a polygon
"nearby" at 1.4× the radius. `/api/site-intel/buildings` returns them with the
radius used and **`loadedTotal`**.

Both halves are needed. With nothing to snap to, the reason is either "no
buildings near this site" or "no building polygons are loaded at all", and
those call for different things from the user. Reporting a bare zero would be
§0 rule 4 again, in miniature.

Snap targets are cleared with the site. Left in place they would be invisible
corners belonging to the previous building — the worst kind, because the shape
they came from is no longer drawn.

### The drag

`mousedown` on a handle claims the pointer and disables `dragPan`; without that
the map slides while the vertex stays put, which looks like a broken handle.
Release re-enables it — and `mouseleave` on the canvas releases it too, so a
drag that ends off the map cannot leave panning disabled with no way to get it
back.

### Verified in the browser

The geometry is unit-tested, but none of the above is geometry. Driven through
Playwright: Edit shape seeded four points from the existing footprint; a corner
drag moved the saved area 4,044 m² → 3,349 m² with the override note shown; the
`copy` cursor found over a midpoint and a click there took it to five points; a
re-click on a placed corner left the count at three; a click on open map in edit
mode left it at four; Undo absent in edit mode and present in draw mode; the
cursor back to `grab` after Cancel.

Snapping was proven by dragging a corner onto neighbour `SAMPLE-BLD-0002`'s
top-left corner at three release distances. At 150 px and 170 px the saved ring
held the pointer's own coordinate; at 190 px it held `[-1.12045, 53.50815]` —
the neighbour's published vertex, exactly.

### What was built

| file | role |
|---|---|
| `draw.ts` | rings, midpoints, insert/move/remove, snapping, hit-testing — no React, no MapLibre |
| `stores.ts` | `buildingsNear()`, centre-distance filtered |
| `api/site-intel/buildings` | neighbours, the radius used, and the loaded total |
| `LandMap.tsx` | neighbour, midpoint and snap-indicator layers; drag, insert, delete; `startEdit` / `setSnap` / `showNeighbours` |
| `SitePanel.tsx` | Edit shape, the mode-aware hint, the snap toggle and its provenance note |

**24 tests**, 405 across the suite.

### Not done

- **No edge dragging.** A whole edge cannot be moved; both its corners have to
  be dragged in turn.
- **No snapping to edges, only to corners.** Putting a vertex on a neighbour's
  wall *between* its corners is not supported, and that is a real case for
  terraces. *(Done in §2o.)*
- **No rectangle or right-angle assist.** Buildings are mostly orthogonal and
  nothing helps the user keep them so.
- **Neighbours are the 120 largest in the bbox**, not the 120 nearest. At the
  current scale nothing is dropped; at national scale a dense street would lose
  its smallest buildings as snap targets.
- **Holes are still dropped.** `outerRing` takes the outer ring only, so a
  courtyard building edited here comes back solid.
- **Nothing is touch-tested.** The drag is mouse events; a tablet is untried.

## 2o. S-01 edge snapping

§2n snapped to corners and named the gap: a vertex could not be put on a
neighbour's wall *between* its corners. For a terrace that is the normal case —
the party wall runs the length of the building and the corner you want is a
point somewhere along it that nobody has ever published.

### The fraction is taken on screen, the point is placed on the wall

`footOnSegment` returns the closest point on a wall as a **fraction along it**
rather than as a coordinate, and the caller applies that fraction to the wall's
own lng/lat. The detour is the whole design:

- the result has to lie **exactly** on the neighbour's wall as stored. That is
  the point of snapping at all — two polygons sharing a line rather than
  disagreeing by half a metre. Un-projecting a screen point back would land
  fractionally off it, which is the same defect with extra steps;
- the perpendicular is taken **on screen**, because that is where the user is
  aiming and where the threshold is measured (§2n). A perpendicular computed in
  degrees is not the one they can see: a degree of longitude is about six
  tenths of a degree of latitude on the ground at these latitudes, so the foot
  would sit visibly off the pointer.

`t` is clamped to [0, 1]. Without it a vertex dragged past the end of a short
wall would snap to a point on that wall's *infinite line*, out in a field.

### Walls are a tighter target than corners

`SNAP_EDGE_PX` is 8 against `SNAP_PX`'s 12, and the difference is not a taste
judgement. A corner is a point you aim at; a wall is a line you cross. Walls
are continuous and cover far more of the map than corners do, so at equal
tolerance a vertex dragged across a street would stick to every wall it passed.

Keeping the wall threshold **below** the corner one also buys a property worth
having: a wall snap can never land on a corner. At the ends of a segment the
closest point is the corner itself, and any corner that close was already
claimed by the corner rule.

### Corners beat walls, and not because they are nearer

The obvious rule is "nearest target wins". It is wrong. Near a corner the foot
of the wall is *almost exactly the corner too*, so nearest-wins has the point
stick to the wall a hair short of the corner — which is precisely the corner
the user was aiming at. A corner in range settles it, and the wall is only
consulted when no corner is.

### Not the shape's own walls

§2n excluded the shape's own corners because dragging one onto its neighbour
collapses the edge between them. Its own walls are excluded for a blunter
reason: **every vertex already lies on two of them**, at distance zero. Include
them and no vertex could ever be dragged anywhere at all.

### The indicator had to change

A corner snap explains itself — there is a visible corner under the ring. A
wall snap does not: the point lands mid-side where nothing is drawn, and the
ring alone looks arbitrary. So the wall that was taken is **lit along its whole
length** while the snap holds.

`SnapResult` gained `kind` and `edge` to carry that, and a `source` that names
whichever target was taken without the caller unpicking which kind it was.

### A performance change that had to come with it

`candidatesFrom` was being called on **every `mousemove`**, which fires on every
frame of a drag. Corners alone made that wasteful; adding a wall per corner
doubled it. Targets are now built once, in `showNeighbours`, and cleared with
the site.

### The bug this slice found: overrides were write-only

Verifying the above meant reading the saved polygon back, and the sample site
turned out to be carrying a drawing that the panel was not showing.

`getProfile` builds a profile from source data and **never consulted the stored
one**. So a saved footprint override survived exactly as long as the page did:

- search the site again and the panel showed the **published** polygon, with no
  "your drawing" badge, no stale-constraint warning, and — worst — no "Revert
  to published" button, so the drawing could not even be undone;
- pressing Confirm then **destroyed** it, because the POST re-saves whatever
  the resolve produced and `saveProfile` overwrites `footprint_original`.

The data was in the database the whole time. It was simply unreachable, which
makes the §2m "keep the original" guarantee worthless in the only scenario that
matters: coming back to a site tomorrow.

`withStoredOverrides` now carries the user's overrides onto a freshly resolved
profile. Three decisions in it:

- **Only the overrides travel.** Address, LPA, screening states and lineage are
  re-resolved on purpose — the point of resolving again is to get what the
  sources say now.
- **The drawing is re-applied through `applyOverride`**, not copied field by
  field, so the T4 lineage record, the `footprint_overridden` flag and the
  dropped `footprint_inferred` flag stay consistent with a drawing made today.
- **The stored original wins.** `applyOverride` would capture today's published
  polygon as "the original", under today's date. What the audit trail needs is
  the shape that was there when the user drew over it, and when.

A confirmation travels too: it is a person saying "this is the right building",
and it is the same UPRN.

The building id convention (`UPRN-<uprn>`) moved into `types.ts` as
`buildingIdFor`. It had been spelled out in the client only, so the server had
no way to find the row the client had written — a drift between the two ends
would not error, it would quietly create a second row and lose the drawing.

**A moved pin needed nothing**, and that is the §2m design paying off: Move pin
stores a *UPRN*, not the click, so re-resolving by that UPRN returns the same
coordinates from OS Open UPRN. An override that stored a raw coordinate would
have needed carrying too.

### Verified in the browser

Pixels per degree calibrated from the map's own scale control, then the site's
south-west corner dragged onto the middle of `SAMPLE-BLD-0002`'s west wall —
the party wall it shares with the site. The saved ring came back holding
`[-1.12045, 53.50768879556152]`: longitude **exactly** the wall's, latitude an
arbitrary value 25 m from the nearest corner on that line and equal to no
published corner at all. That is a wall snap and could be nothing else.

The indicator was checked by sampling the wall's screen column for the
indicator blue: **0 px before the drag, a 107 px run while the snap held, 0 px
after cancelling**. The screenshot shows the wall lit from end to end with the
ring sitting on it.

Then the site was searched for again from a fresh page load: **1,056 m², "your
drawing", and Revert offered.** Before the fix the Revert button was not even
present.

### What was built

| file | role |
|---|---|
| `draw.ts` | `SNAP_EDGE_PX`, `SnapEdge`, `SnapTargets`, `footOnSegment`, `edgesFrom`, `targetsFrom`; `snap` now decides corner-then-wall |
| `profile.ts` | `withStoredOverrides` |
| `service.ts` | `getProfile` consults the stored profile |
| `types.ts` | `buildingIdFor`, shared by both ends |
| `LandMap.tsx` | the lit-wall layer, targets built once per site |
| `SitePanel.tsx` | wording for walls, and the shared building id |

**24 more tests**, 429 across the suite.

### Not done

- **No edge dragging.** A whole wall still cannot be moved; both its corners
  have to be dragged in turn. *(Done in §2p.)*
- **No rectangle or right-angle assist.** Buildings are mostly orthogonal and
  nothing helps the user keep them so.
- **Neighbours are the 120 largest in the bbox**, not the 120 nearest.
- **Holes are still dropped**, and the snapped wall is always an outer ring, so
  a courtyard's inner wall is not a target.
- **Nothing is touch-tested.**
- **The carry-forward is not covered by an end-to-end test**, only by unit
  tests and a browser run. It depends on the client and server agreeing on a
  building id, which is now one function but still an agreement.

## 2p. S-01 edge dragging

§2o's remaining gap: a wall could be snapped to but not moved. Squaring a
building off meant dragging two corners in turn and hoping they ended up
parallel to where they started.

### The move is rigid, and that is enforced rather than intended

`moveEdge` translates both ends of a wall by one delta. The component applies
the move through it rather than making two `moveVertex` calls, which would only
*happen* to be rigid — nothing would catch it if they stopped being. Keeping
length and angle is the entire reason to have this gesture: moving the two
corners separately is already possible and cannot help but change the wall.

### The wall follows the pointer, not the other way round

The delta is the **pointer's travel since the press**, not the gap between the
cursor and the wall. Grabbing a wall near one end and having it jump so its
midpoint lands under the cursor is the classic way to make a drag feel broken.

There is one piece of bookkeeping behind that. When a snap fires, the wall
lands somewhere the pointer is not, so the pointer's reference is moved by the
same amount the wall was. Without it the next frame would re-apply the snap on
top of itself and the wall would creep away from the cursor. With it, the raw
position is always *the original corner plus total pointer travel*, so a snap
holds while the pointer stays near the target and releases cleanly when it does
not — verified in the browser as a 45 px drag producing exactly 45 px of
movement.

### A press on a wall is not yet a drag

The midpoint handle sits on its wall, so a press there is ambiguous: insert a
corner, or move the wall? Resolving it by position — "the midpoint inserts, the
rest of the wall drags" — fails on short walls, where the midpoint's 12 px grab
radius covers most of the wall and there is nowhere left to drag from.

So the press is **pending** until the pointer travels `DRAG_START_PX`. Below
that it is still a click, and a click on a midpoint inserts, exactly as before.
Above it, it is a wall drag. Panning is disabled at press time regardless,
because by the time the threshold is crossed the map would already have moved
under the shape.

This replaced the separate `click` handler on the midpoint layer, so insert and
drag now come out of one decision instead of two that could both fire.

### Snapping a wall can only be a translation

`snapDraggedEdge` offers **both** ends to the snapper and takes whichever lands
closest to a target; the whole wall then moves by the delta that puts that end
exactly on it. Snapping the two ends independently would pull them to different
targets and **shear** the wall — which is precisely what dragging the two
corners already does, and so would leave this gesture with no reason to exist.

The effect is the terrace gesture: a wall clicks into place as either of its
corners meets a neighbour's.

### Walls belong to edit mode

In draw mode a click is still placing corners, and a click that lands on the
line already drawn has to stay a corner — a concave shape needs exactly that.
So `edgeAt` is consulted only when `appendOnClick` is false. The cursor says so:
over a wall it is `move` in edit mode and `crosshair` in draw mode.

### One hit-test, so the cursor cannot lie

The cursor used to come from MapLibre's per-layer `mouseenter`, while the press
used `vertexAt`. Two mechanisms for one question, free to disagree. They are now
a single `targetAt`, used by both, so what the cursor promises is by
construction what the press does: `move` over a corner or a wall, `copy` over a
midpoint, `crosshair` over open map.

Fixing that exposed a smaller one that had been there since S-02. The
constraint, ECR and substation layers set a `pointer` cursor on hover with no
regard for draw mode, and they are registered after the draw handlers, so they
won: mid-drag over a green belt the cursor promised a popup that `drawActive`
then refused to open. Those handlers are now silent while drawing or picking,
like every other handler in that position.

### Verified in the browser

Pixels per degree calibrated from the scale control, then the north wall
grabbed 30 px west of its midpoint — on the wall, clear of every handle:

- **snapping off, dragged 45 px north:** exactly **2 of 4 corners moved**, and
  they were adjacent; the delta was **identical** on both; the wall's length
  came back `1.100000e-3` against `1.100000e-3` before; and the movement was
  **45.0 px**, the drag exactly.
- **snapping on, dragged 89 px north** — the gap to `SAMPLE-BLD-0002`'s
  top-left corner: the east end landed **exactly** on `[-1.12045, 53.50815]`,
  the move stayed rigid, and the west end came along to `[-1.12155, 53.50815]`.
- **a midpoint click still inserts**: 4 points to 5.
- **draw mode**: the cursor over a wall is `crosshair`, not `move`.
- cursors: `copy` over the midpoint, `move` over the wall, `crosshair` over
  open map. No page errors.

### What was built

| file | role |
|---|---|
| `draw.ts` | `GRAB_EDGE_PX`, `DRAG_START_PX`, `edgeAt`, `moveEdge`, `snapDraggedEdge` |
| `LandMap.tsx` | `targetAt` as the one hit-test, the pending-press state machine, `moveEdgeTo`, hover cursors silenced while drawing |
| `SitePanel.tsx` | the edit hint names the wall gesture |

**17 more tests**, 446 across the suite.

### Not done

- **No rectangle or right-angle assist.** Buildings are mostly orthogonal and
  nothing helps the user keep them so. Dragging a wall preserves an angle; it
  cannot correct one. *(Done in §2q.)*
- **No wall snapping to parallel alignment.** A wall clicks into place when a
  *corner* meets a target. Two walls that should be collinear but share no
  corner still have to be lined up by eye.
- **No removing a wall** (merging its two corners). Only vertices are removable.
- **Walls cannot be dragged in draw mode**, by design above, but that is a
  split a user has to learn rather than see.
- **Neighbours are still the 120 largest in the bbox**, holes are still
  dropped, and nothing is touch-tested.

## 2q. S-01 right-angle assist

The last of the three gaps §2n opened. Buildings are overwhelmingly rectilinear
and nothing helped the user keep them so: every corner was placed by hand and
came out a degree or two off.

### It can only mean square to the adjoining wall

The obvious reading — constrain to horizontal and vertical — is useless here. A
building sits at whatever bearing its street does, and almost none of them are
aligned to north. "Right angle" has to mean **square to the wall beside it**,
measured from the shape's own geometry, or it helps with nothing.

So the primitive is a **hinge**: the corner a moving wall turns on, and the far
end of the wall the angle is measured from. Dragging a vertex offers two, one
on each side; placing a corner offers one, the wall running back from the last
point. Neither hinge moves, so both are stable references mid-drag.

The vertex then slides along an **arc centred on the pivot** to the nearest
right-angled bearing. Its distance from the pivot is untouched, so the wall
length the user chose survives and only the bearing is corrected — the
alternative, moving it perpendicular onto a line, would silently change how big
the building is.

### A right angle is an assumption, not evidence

This is the decision that shapes everything else about it.

Snapping (§2n, §2o) puts a point on something a source published. Squaring puts
it where **no source says anything**, on the grounds that buildings are usually
rectilinear — usually, and this one may not be. That difference is carried
through three ways:

- **Last in precedence, and never on distance.** Where a corner or a wall is
  also in range, the published one wins *however much nearer the right angle
  happens to be*. Taking the guess would quietly move the point off real data.
- **Its own toggle.** Riding on the snap checkbox would mean turning off
  alignment-to-data in order to turn off geometry-guessing.
- **Its own colour.** Blue means published; amber means inferred. Both arms of
  the angle are drawn, because with two walls meeting at the pivot "square to
  what?" is a real question.

The first version gave a squared corner the blue ring as well as the amber
arms, which said "this point is on published data" about a point that is not.
Caught by looking at the screenshot. The ring is now data-only, and the amber
arms end at the vertex, so the jump is still explained.

### Degrees are not degrees

The angle is worked in a frame where longitude is scaled by cos(latitude). In
raw lng/lat a corner that measures 90° is not 90° on the ground or on the
screen, because a degree of longitude here is about six tenths of a degree of
latitude — the same trap as §2o's perpendicular.

Screen space would serve equally well, since Web Mercator is conformal and
therefore preserves angles, but that would need an unprojection this module
deliberately does not have. The local frame gets the same answer with the
inputs already to hand.

### The tolerance is a distance, so it is not a fixed angle

`SQUARE_PX` is 8 px of **correction**, not 8° of angle, which follows from
§2n's screen-pixel rule. The consequence is worth stating because it surprised
me while writing the tests: the same angular error is a bigger correction
further from the pivot, so **a long wall has to be aimed more precisely than a
short one**. ~7° off square is taken at 11 px out from the pivot and refused at
110 px.

That is the right way round. On a short wall the angle cannot be judged by eye
at all; on a long one it can, so an error there is more likely to be deliberate.

### Two turns are offered, and one is refused

A quarter turn either way is a corner. A half turn — the two walls running
straight on through the pivot — is a legitimate shape and is offered. A **zero**
turn would lay the moving wall back along the reference wall and give the shape
a zero-area spike, so it is refused outright rather than left to the threshold.

### Verified in the browser

- **Placing a corner**, clicked 6 px off perpendicular: the corner before it
  came out at **90.000000°**.
- **Dragging a vertex** 60 px with a 5 px lean: the corner at the hinge came
  out **90.000000°**, and the amber arms were drawn (1,882 px of amber).
- **The same drag with the assist off**: **79.09°** and **88.98°** — neither
  square. That pair is the cleanest evidence there is.
- **Around the dragged handle while squared: 42 px of amber, 0 px of the
  indicator blue**, so the colour code holds.
- Both toggles present and independent. No page errors.

The angle at the *dragged* vertex ends up 78.26°, which is not a defect: one
corner of a rectangle cannot be moved with every angle preserved. The assist
squares the hinge, which is the corner the user is not touching.

### What was built

| file | role |
|---|---|
| `draw.ts` | `SQUARE_PX`, `SquareHinge`, `squarePosition`, `hingesForVertex`, `hingesForAppend`; `snap` gains the third precedence step |
| `LandMap.tsx` | the amber layer, hinges at both call sites, `setSquare`, the ring made data-only |
| `SitePanel.tsx` | the second toggle and the note on what amber means |

**20 more tests**, 466 across the suite.

### Not done

- **A dragged WALL is not squared.** Translating a wall preserves its own
  bearing but changes its two neighbours', and correcting those would constrain
  the translation — a different problem, not attempted. *(Done in §2t.)*
- **No parallel alignment.** A wall clicks square to the wall beside it; two
  walls that should be collinear but share no corner are still lined up by eye. *(Done in §2r.)*
- **Nothing squares a shape after the fact.** There is no "regularise this
  polygon" action, only help while a point is moving.
- **The assist is on by default**, which means a corner that genuinely is not
  square takes a little care to place. The toggle is right there, and the
  correction never exceeds 8 px, but it is an assumption applied unasked.
- **Neighbours are still the 120 largest in the bbox**, holes are still
  dropped, and nothing is touch-tested.

## 2r. S-01 parallel alignment

§2q squared a wall to the one beside it. That keeps a corner honest and says
nothing about the rest of the building: drag the north-west corner of a
rectangle and there was no way to ask for the west wall to stay parallel to the
east one, because they share no corner and no angle between adjoining walls
expresses the relationship.

### It is the same mechanism, not a second one

Squaring already fixes the **bearing** of the moving wall to a quarter turn from
a reference wall. Parallel is the same operation with the reference taken from a
wall elsewhere on the building instead of the one adjoining the pivot. The
arithmetic cannot tell them apart and neither should the code, so there is one
function and one toggle rather than two of each.

The hinge type carries that: a `pivot` the wall turns on, a `reference` **wall**
whose bearing is copied — only its direction matters, so it need not touch
anything — and the pivot's `adjoining` vertex.

Naming followed: `SquareHinge` became `AlignHinge`, `SQUARE_PX` became
`ALIGN_PX`, and the result kind `"square"` became `"align"`. Calling a parallel
a square would have been wrong in the one place a reader looks to find out what
happened.

### The fold-back check had to become geometric

§2q refused a zero turn from the reference, which laid the moving wall on top of
the wall already at the pivot. That rule worked while the reference *was* that
wall. It breaks the moment other walls are offered, and breaks in the commonest
case of all: **in a rectilinear building the wall opposite is parallel to the
wall beside**, so it carries the very same four bearings — including the folded
back one. A different reference would have quietly re-admitted the spike.

So the check now asks where the point ends up, not which reference produced it:
refuse if the resulting bearing is within a thousandth of a radian of the
direction from the pivot to its other neighbour.

### Which walls are references, and which are not

For each of the two pivots, **every wall of the shape that is standing still**.
The two walls touching the dragged vertex are excluded: they are the ones
moving, so their bearing is the answer, not the question.

The wall adjoining the pivot is offered **first**, and `snap` keeps the first of
equal candidates. That matters because in a rectilinear building several
references give the same bearing, and the one worth reporting and drawing is the
relationship the user can actually see.

A reference reaches the builder twice — once as the adjoining wall and again
walking the ring in the other direction — and is de-duplicated, so a rectangle
yields two references per pivot rather than three.

### Neighbours' walls are deliberately not offered

The terrace case — my wall parallel to theirs — is reachable already and by a
better route: §2o snaps a vertex onto a neighbour's wall, so putting both ends
of a wall on theirs makes the two collinear, from published data rather than
from a guess. Once one wall is flush, the shape's own grain carries the rest.

Offering every neighbour's bearing would also make the tool sticky for no gain:
in a mixed street it would click to bearings that mean nothing to this building.
As built, **the assist can only ever align the shape to its own grain**, which is
a limit worth having.

### One frame, the pivot's

The longitude scale is cos(latitude), so it differs very slightly between two
walls at different latitudes. Both the moving wall and the reference are read in
the **pivot's** frame, so "parallel" does not depend on which end you measure
from.

This showed up in verification: measured in a single frame the two walls came
out parallel to **3.3e-12 degrees**, floating-point exact; measured with each
wall in its own frame, 1.1e-4 degrees. The second number is the wrong question,
and in any case is under a fifth of a millimetre on a 100 m wall.

### The indicator became two strokes

§2q drew an elbow — reference wall, pivot, moved wall — which only reads as an
elbow when the reference touches the pivot. For a parallel it does not. The
indicator is now the **moved wall and the reference wall** as two amber strokes,
which degenerates to the old elbow when they happen to meet, and otherwise looks
like what a parallel is.

### Verified in the browser

A quadrilateral with four distinct bearings, so that "parallel to the wall
opposite" and "square to the wall beside" give different answers and the result
says which happened. Three corners placed with both assists off, then the
alignment toggle turned on and the fourth placed 5 px off parallel with the
first wall:

- reference wall `11.3100°`, moved wall `-168.6900°` — **off parallel by
  3.3e-12 degrees**;
- and **5.79° off any quarter turn of the adjoining wall**, so it is not the §2q
  behaviour wearing a new name;
- 562 px of amber drawn while placing;
- the identical clicks with the assist off left the wall **0.88° crooked**.

### What was built

| file | role |
|---|---|
| `draw.ts` | `AlignHinge`, `alignPosition`, the geometric fold-back check, hinge builders over every standing wall; `SQUARE_PX`/`"square"` renamed to `ALIGN_PX`/`"align"` |
| `LandMap.tsx` | the indicator as two strokes rather than an elbow |
| `SitePanel.tsx` | "Keep walls square and parallel", and the note saying the reference wall is lit too |

**13 more tests**, 479 across the suite.

### Not done

- **Neighbours' bearings are not references**, by the reasoning above. A terrace
  whose party wall is shorter than yours cannot be matched by edge snapping
  alone, and that case is still eye-work.
- **No collinear alignment.** A wall can be made parallel to a distant one but
  not put on the same line as it — "line up with the building line" is not
  expressible. *(Done in §2s.)*
- **A dragged WALL is still not aligned**, only a dragged or placed vertex. *(Done in §2t.)*
- **Nothing regularises a shape after the fact**; the assists only help while a
  point is moving.
- **Holes are still dropped**, neighbours are still the 120 largest in the bbox,
  and nothing is touch-tested.

## 2s. S-01 collinear alignment

§2r made a wall parallel to a distant one. Parallel gets the bearing right and
leaves the position to the user, so "line up with the building line" — my
frontage on the same line as the terrace's, even where the two do not touch —
was still eye-work.

### A different mechanism, and a different claim

Square and parallel fix a **bearing**. In-line fixes a **position**: the vertex
sits on the line a wall establishes. So this is not another reference direction;
it is a constraint of its own, and it is implemented as one.

### The boundary with snapping is exactly where the wall stops

This is the decision the whole slice turns on. §2o already snaps a vertex onto a
neighbour's wall, clamped to the segment, and draws it blue — the point is on
something a source published. Past the end of the wall, the same line is no
longer published: it is our extrapolation that the frontage carries on.

So **in-line offers only the extension**. Between the wall's own ends it
declines, because that is the snap tier's territory and offering it here would
put a blue claim behind an amber indicator. The tiers meet exactly at the ends
of the wall, which is also exactly where the evidence stops.

The indicator says the same thing in one picture: the wall is drawn **solid**
and the part we carried on **dashed**.

### How far a line reaches

A line extended without limit would tile the map — with a street's worth of
neighbours, every drag would click to some distant wall's continuation. The
reach is **one wall-length past each end**, so it scales with the thing making
the claim: a 10 m wall speaks for the next 10 m either side, a 60 m one for 60.
No fixed constant to defend.

Note that a line is a far less sticky target than a bearing, which is why
neighbours' walls ARE offered here when §2r deliberately refused their bearings:
a bearing matches anywhere in the plane, a line only along a one-dimensional
locus. The terrace case §2r left open is answered here.

### The fold-back check had to become global

§2r made it geometric. It now also has to run over **every** hinge rather than
the one that produced the candidate, because a vertex has two moving walls and a
correction computed for one can perfectly well fold the other. In-line needs the
same guard for a new reason: a wall's line extended backwards passes straight
through the pivot and out along the wall already standing there, so sitting on
it would lay one wall on the other.

One function, `foldsBack`, now guards both assists.

### Nearest wins between the two assists

Square, parallel and in-line are one tier and one toggle: they are the same kind
of guess, unlike the boundary with published data, which is categorical. Within
the tier the **nearer correction is taken**, with in-line gathered first so it
holds a tie.

### The indicator was missing from draw mode entirely

Verifying this found a gap that had been there since §2n. `showSnap` was only
ever called from `withSnap`, which ran on a **click** when placing corners and
on **mousemove** only during a drag. So while drawing, the indicator appeared
for the instant of the click and was cleared on the next line — in practice,
never.

Which means a click that placed a corner somewhere other than where the user
clicked went **unexplained**, which is the exact thing the indicator exists to
prevent. It now previews on hover while placing corners: the returned vertex is
discarded, only the drawing is kept.

That is also why the first browser run reported **0 px of amber** while the
geometry was already correct. The number was right and the feature was invisible.

### Verified in the browser

`SAMPLE-BLD-0002`'s west wall runs along lng `-1.12045` from lat 53.50745 to
53.50815. A corner was placed **67 px past its north end**, 4 px east of the
line — out of reach of edge snapping, which clamps to the segment:

- **with the assist on**, the saved corner came back at lng **exactly
  -1.12045**, at lat 53.5083 — past the wall, on its line;
- **with the assist off**, the identical click gave `-1.124348…`, **4 px off**;
- the indicator drew **238 px of solid amber along the wall and 48 px of dashed
  amber past its end** (48 of 67 px, which is a 2-2 dash);
- snapping was off throughout, so nothing but the line assist could have done it.

The sample database was killed twice during this slice — not shut down, killed,
with no clean-shutdown record and `dmesg` unavailable, so the cause is
unconfirmed; memory pressure with Chromium, `next dev` and Postgres together is
the likely one. The verification script now checks the database is still up at
the end, so a mid-run death cannot produce a quiet pass.

### What was built

| file | role |
|---|---|
| `draw.ts` | `Assist`, `footOnLine`, `LINE_REACH`, `linesForVertex`, `linesForAppend`, the `"inline"` result kind, `foldsBack` extracted and made global |
| `LandMap.tsx` | the dashed-extension layer, lines supplied at both call sites, the hover preview while placing corners |
| `SitePanel.tsx` | "Keep walls square, parallel and in line", and the note on what dashed means |

**14 more tests**, 493 across the suite.

### Not done

- **A wall cannot be made collinear as a wall**, only a vertex put on a line.
  Getting a whole wall onto a neighbour's line still means placing both its ends
  there.
- **No snapping to the line of a wall of a building that is not loaded.** This
  rides on the same `os_building` coverage as everything else (TICKET-15).
- **The reach is one wall-length**, which is a defensible rule rather than a
  measured one. A short wall on a long frontage speaks for less of it than a
  surveyor would.
- **A dragged WALL is still not aligned**, only a dragged or placed vertex. *(Done in §2t.)*
- **Nothing regularises a shape after the fact**; the assists only help while a
  point is moving.
- **Holes are still dropped**, neighbours are still the 120 largest in the bbox,
  and nothing is touch-tested.

## 2t. S-01 wall alignment

Named as undone in §2p, §2q, §2r and §2s: the assists helped a vertex being
dragged or placed, and did nothing for a whole wall being dragged.

### A translated wall's own bearing cannot be corrected

That is what a translation means, and it is the point of the gesture (§2p). So
"wall alignment" cannot mean aligning the wall being dragged. What a translation
*does* change is the two walls either side — they stretch and tilt — so those are
what the assist works on. Each hinges on the vertex beyond the end it touches,
and can be brought square or parallel to any wall standing still.

**Three** walls change when one is dragged, not two: the wall itself and the one
at each end. All three are excluded as references and as lines.

### The correction had to be a projection, not an arc

This is the decision the slice turns on, and getting it wrong would have made
the feature worse than nothing.

`alignPosition` (§2q) keeps the moving point's **distance** from the pivot and
turns it. That is right for a dragged vertex, where the user chose that wall's
length and only its bearing is wrong.

Apply the same thing to a dragged wall and it jams. Drag the north wall of a
rectangle square-on: the north-west corner's distance from the south-west corner
is exactly what the drag is changing, so preserving it holds that corner where
it began — and since the move is rigid, the whole wall refuses to budge.

So a second form, `alignProjection`, takes the **shortest route onto the aligned
line** and keeps nothing. Drag north-and-a-bit-east and it strips the eastward
part, leaving the northward part untouched: the wall slides square. Which form
to use is a property of the gesture, so it rides on the `Assist` object as
`by: "arc" | "projection"` rather than being a parameter the caller might get
wrong.

### The fold-back guard now runs on both ends

`snap` checks the end it was given. A wall moves both, and a correction that
suits one can fold the other back onto the wall standing at its pivot. The
translation is therefore checked at both ends after the fact and **refused
outright** if either folds — a translation that cannot be made without a spike is
not one the user asked for.

### One indicator builder

The vertex path and the wall path each turned a `SnapResult` into ring, wall,
amber and dashed geometry. Two copies of the same mapping, free to disagree about
what a given result looks like. Now one function, `indicatorFor`, used by both.

### Verified in the browser

The north wall of the published rectangle, grabbed 30 px west of its midpoint,
with snapping off so nothing but the assist could act:

| drag | corner angles | wall moved | rigid |
|---|---|---|---|
| 40 px N + 5 px E, assist **on** | **90.000000° / 90.000000°** | 40 px N, **0 px E** | yes |
| the same drag, assist **off** | 88.905202° / 91.094798° | 40 px N, 5 px E | yes |
| 40 px square-on, assist **on** | 90.000000° / 90.000000° | **40 px N**, 0 px E | yes |
| 40 px N + 20 px E, assist **on** | 85.628776° / 94.371224° | 40 px N, **20 px E** | yes |

Row three is the one that matters most: the full 40 px went through. That is the
case the arc form would have jammed. Row four is the release — a deliberate
sideways drag, past the 8 px the assist absorbs, goes through untouched.

The amber indicator rose from a 563 px page baseline to 1,041 px during the
aligned drag and fell back to 565 px on cancel. Sampling the individual edges
found the moved-wall stroke (412 px down the right edge), the reference wall
(106 px along the bottom), and **1 px** down the left — two strokes, as designed,
not three.

### Not done

- **The reference stroke is hard to see.** For a wall drag the reference is
  always an edge of the shape being drawn, so the amber competes with the red
  dashed outline on top of it; it took a loose colour test to find at all. The
  geometry is right and the stroke is there — it just does not read.
- **No rotating a wall.** Its bearing is fixed by the gesture; correcting it
  would need a different control.
- **Nothing regularises a shape after the fact.** The assists only help while
  something is moving.
- **A wall cannot be made collinear as a wall** (§2s), only its ends put on a
  line — though dragging the wall now does both ends at once, so the terrace
  case is one gesture where it was two.
- **Holes are still dropped**, neighbours are still the 120 largest in the bbox,
  and nothing is touch-tested.

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
- **TICKET-09 MEES wording and thresholds** — *blocking for client use.* All 17
  entries in `mees_rules.yaml` unapproved. This describes a legal duty and part
  of it is not yet law; the band boundaries are transcribed, not derived.
- **TICKET-10 PRS Exemptions Register not held** — a building below EPC E with a
  registered exemption is lawfully let, and we cannot see the register. S-08 is
  now built, so this is live: the caveat is on every below-minimum row, in the
  cohort's own reason and in the export. Decide whether to ingest the register
  or keep the caveat as the answer.
- **TICKET-11 bulk EPC loader unverified** — `npm run epc:load` has never seen a
  real file. Columns are read by name, absent ones are reported and the first
  parsed record is printed, but the schema is from the published spec.
- **TICKET-02** UPRN provenance · **TICKET-03** attributions unverified ·
  **TICKET-04** constraint wording unapproved · **TICKET-05** CCOD/OCOD licence
  unread · **TICKET-06** VOA slugs and column positions unverified ·
  **TICKET-07** fixture sites not chosen · **TICKET-08** stack decision.
- **TICKET-13 grid thresholds and wording** — 9 blocks in `grid_rules.yaml`
  unapproved, including the RAG bands, which are our defaults and not a
  regulated classification.
- **TICKET-14 G98/G99 values are null placeholders** — deliberately, so reading
  them fails loudly. Nothing reads them yet. Replace from ENA Engineering
  Recommendation G98/G99 before the PV export screen takes a real input.
- **TICKET-15 no real OS OpenMap Local load.** The footprint store and its
  loader are verified against an invented fixture and a synthetic British
  National Grid file that it correctly refuses. No real extract has been
  loaded, and coverage is whatever has been. Snap targets come from the same
  table, so outside the loaded extract snapping is inert (§2n).
- NESO "GIS Boundaries for GB DNO Licence Areas" loader now exists
  (`npm run grid:boundaries`), but has only been run against an invented
  fixture — the real GeoJSON has never been fetched.
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

- **Headroom RAG bands.** Now in `grid_rules.yaml` (≥10 MVA green, 2–10 amber,
  <2 red), used only where the DNO publishes no rating of its own. Ours, not a
  regulated classification. `src/lib/headroom.ts` keeps the same defaults for
  the map layer.
- **S-03 screen fractions.** A proposal at or under 50% of published headroom is
  green, to 90% amber, above that red. My judgement, not a published tolerance.
- **S-03 proximity radius and count.** Nearest 5 within 10 km where no supply-area
  polygon exists. Confirm both.
- **S-03 G98/G99.** Currently null placeholders (TICKET-14). Supply the figures
  before the PV export screen is wired to a real export capacity.
- **Grid caveat wording.** Implemented verbatim from brief §5.4 in
  `src/lib/grid.ts`. Confirm it reads correctly.
- **Fixture sites.** The brief asks for 8 confirmed sites; none chosen yet.
- Stack and phase order — §3 above. Map library resolved (MapLibre).
- **S-07 use-keyword mapping.** `search-use.ts` maps words like "warehouse" and
  "industrial" onto regular expressions over the VOA primary description. That
  is an interpretation of VOA's vocabulary, not a published mapping, and it
  decides what a search returns. Needs a read-through.
- **S-05 MEES wording and thresholds.** `mees_rules.yaml`, all 17 entries. The
  most consequential sign-off in the repo: it states a legal duty, and the 2031
  EPC B target it encodes is proposed rather than enacted. Read it against
  SI 2015/962 and the DESNZ interim response of 18 June 2026 before approving.
- **S-05 the ±10% area margin.** A floor area within 10% of 1,000 m² returns
  "cannot determine which regime applies" rather than a classification. That
  margin is my judgement, not a published tolerance — confirm it is the right
  width, or replace it with a rule about which area sources may be trusted for
  the threshold at all.
- **S-03 map technology colours.** Seven technology groups in
  `grid-layers.ts`, with a colour each and a `solar-wins` rule where a register
  string names more than one (a "Solar PV with battery storage" connection is
  drawn as solar). Presentational, but it decides what a prospecting reader
  sees first.
- **S-02 map colours and grouping.** Five categories in
  `constraint-layers.ts` (heritage, designated land, ecology, flood, other),
  with a colour each. Presentational, deliberately not in the YAML so the
  sign-off stays about wording — but the grouping is editorial and a client
  will read it, so it wants a glance.
- **S-08 cohort names and reasons.** Seven cohorts in `prospects.ts`, each with
  a label, criteria and a reason. They are the words a client will read on a
  prospect list; none of them says compliant or non-compliant, and a test keeps
  it that way, but the framing is mine.
- **S-08 the KFIM benchmark.** 73.38% at B or above, 2025. In the rules file with
  its citation and caution. Confirm you want a managed institutional portfolio
  used as the comparator for the general stock of an area at all.
- **S-05 the 250 kWh/m²/yr primary-energy flag.** A screening level from the
  Focus Green policy reference, applied to gas and oil buildings only. Confirm
  it is the level you want and that the fuels it applies to are the right set.
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
