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
