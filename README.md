# NZCAI

NZC and ESG AI App.

The **Land** module resolves a building from an address (S-01), screens it for
planning and environmental constraints (S-02), checks nearby DNO grid capacity
for solar PV (S-03), screens its EPC and MEES position (S-05), identifies likely
corporate owners (S-04), pulls floor area and use from the VOA rating list
(S-06), finds candidate sites from a plain-English question (S-07), and lists
MEES prospects across the loaded stock (S-08). See
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

## EPC register (Task 0)

```bash
npm run epc:verify -- DN4 8DE    # checks both hosts, breaks results down per register
```

Set `EPC_API_EMAIL` and `EPC_API_KEY` (free, register at
[epc.opendatacommunities.org](https://epc.opendatacommunities.org/login-or-register)).
`EPC_API_BASE` selects the host: the new
`get-energy-performance-data.communities.gov.uk` by default, the legacy
`epc.opendatacommunities.org` if needed. The host that answered is reported on
every lookup.

**This is what makes `exact` matches possible.** With credentials set, an
address resolves through the register at tier T1, and the resolved profile
carries a street address — which lifts the ownership (S-04) and VOA (S-06)
matches from `postcode only` to `address match`, and puts the EPC floor area
alongside the VOA one for cross-checking.

**The register's UPRN is not uniformly authoritative.** `uprn-source`
distinguishes one the register matched from one an energy assessor typed in.
Address-matched is treated as register-grade (T1), assessor-entered as inferred
(T3), and the source is shown on every certificate. See PRELAUNCH TICKET-02.

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

`exact` matches need the EPC register credentials above. Without them every
address resolves at `probable` or `approximate`, both of which require a human
to confirm — which is why the "Is this the building?" step exists.

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

## Ownership (S-04)

Who owns this building, and who controls them.

```bash
npm run site:load-ccod -- CCOD_FULL.csv   # UK companies
npm run site:load-ccod -- OCOD_FULL.csv   # overseas companies (auto-detected)
```

Both from [use-land-property-data.service.gov.uk](https://use-land-property-data.service.gov.uk).
Set `COMPANIES_HOUSE_API_KEY` (free, from
[developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk))
to add company status, officers and persons with significant control.

**Read this before trusting a result.** There is no free path from a building to
a definitive owner. HM Land Registry's INSPIRE polygons carry an INSPIRE ID, not
a title number; the bulk polygon-to-title linkage is the National Polygon
Service at **£20,000 a year**, and CCOD/OCOD are keyed by title number. So this
module works backwards — matching the resolved site's postcode and address
against the property addresses CCOD and OCOD carry as free text.

Every result is therefore **tier T3, inferred**: a lead to verify against the
title register, never proof of ownership. Matches are labelled `address match`
or `postcode only`, conflicting building numbers block an address match, and a
title covering several addresses says so.

With EPC credentials set the resolved site carries a street address and matches
reach `address match`. Without them every match is `postcode only` — several
candidates on a shared postcode, with no way to choose between them.

`?company=` answers the reverse: everything one company owns.

**Licence caution:** CCOD and OCOD are not plain OGL. Both need registration and
acceptance of HMLR's own terms, which carry conditions on redistribution. Those
terms have not been read. Check before any commercial use.

## Floor area and use class (S-06)

```bash
npm run site:load-voa -- list uk-vo-list.csv   # assessments, descriptions, RV
npm run site:load-voa -- smv  uk-vo-smv.csv    # survey lines with floor areas
```

Both from [voaratinglists.blob.core.windows.net](https://voaratinglists.blob.core.windows.net/html/rlidata.htm).
Load the list first — survey lines without an assessment are counted and
dropped.

Three things that will bite otherwise:

- **The files are asterisk-delimited despite the `.csv` extension.** Parsing
  them as CSV gives one giant field per row. The loader prints the first parsed
  record so a mismatch is obvious; override positions with `VOA_LIST_MAP` /
  `VOA_SMV_MAP` as JSON. They follow the published spec but have not been
  checked against a real file.
- **A floor area is meaningless without its basis.** Lines are GIA, NIA, GEA or
  EFA and are never summed across bases. An unstated basis stays `unknown`,
  never silently treated as GIA. This matters: kWh/m², CRREM and NZCBS all
  depend on the denominator.
- **The VOA description is not a planning Use Class.** "WAREHOUSE AND PREMISES"
  is a valuation description. The use class is inferred, only from unambiguous
  descriptions, and labelled as an inference every time.

Floor areas from VOA, from footprint × storeys (`?storeys=`) and from an EPC
(`?epc_area=`) are shown **side by side with their bases** and flagged
`floor_area_check` when they diverge by more than 25%. None is chosen for you —
that's the assessor's call.

Matching is by address, so every result is tier T3. The list carries VOA's UARN,
not a UPRN; the cross reference is in OS AddressBase Premium, a paid product.

## Site search (S-07)

`/land/search` takes a question in plain words:

```
warehouses in DN4 over 1000 sqm with epc below C
offices in DN4 under 500 sqm
overseas owned industrial in DN4 8DE
warehouses in DN4 with substation headroom over 5 MVA
```

**No model is involved.** The query string is parsed by a pure function into a
structured filter and executed as SQL. Nothing about a site or a client is sent
anywhere — brief §0 rule 2.

The interesting part is what the search reports it *didn't* do, because a
dropped clause returns more rows than you asked for and every extra row reads
like an answer. Two channels, shown above the results, not below:

- **Not understood** — words the parser did not recognise. Ask for "warehouses
  near a motorway" and you get warehouses, plus `"near motorway"` listed as
  ignored and a line saying the results are wider than the question asked. The
  parser tracks which characters each matcher claimed, so a phrase cannot be
  quietly dropped: leftovers *are* the report.
- **Understood, but not applied** — clauses that parse and cannot be run over a
  corpus. "Not in a conservation area" is the clear case: constraints are
  screened per site against planning.data at request time, not stored for
  thousands of buildings. Open a site to screen it.

The corpus is the VOA rating list. Use and floor area join on UARN; **EPC band,
overseas ownership and grid headroom join by postcode**, which means "somewhere
in this postcode", not a fact about the building. Every affected result says so.
Treat them as leads to verify — the same T3 linkage limit as S-04 and S-06, for
the same reason: the authoritative cross-reference is a paid product.

A query with no filter in it is refused rather than returning every building in
the list, and a zero result says it reflects the loaded data, not the country.

## Building performance and MEES (S-05)

`/api/site-intel/performance?uprn=` screens a building's EPC against the
non-domestic MEES standards, and the site panel shows it.

**Every threshold and every sentence lives in
`src/lib/site-intel/mees_rules.yaml`, not in code**, sourced to SI 2015/962 and
the DESNZ interim response of 18 June 2026. All 17 entries are `approved: false`
until James signs them off — `npm run site:verify` prints the count outstanding
and the policy position the file currently encodes.

That file matters because the policy moved and most write-ups have not:

| | commonly assumed | actual |
|---|---|---|
| interim milestone | EPC C by 2027 | **dropped**, 18 June 2026 |
| headline target | EPC B by 2030 | EPC B by **2031** |
| applies to | all non-domestic | buildings **over 1,000 m²** only |
| status | in force | **proposed** — secondary legislation still required |

The dropped 2027 milestone is kept in the file on purpose, so the system can
state the negative rather than stay silent about a duty someone may still be
planning against.

### What it will not say

No result says *compliant* or *non-compliant*, and a test enforces that across
the whole rules file. MEES binds a **letting**, not a building — tenure and lease
terms decide whether it bites, and this system holds neither. The **PRS
Exemptions Register is not a dataset we have**, so a building below EPC E may be
lawfully let under a registered exemption. Both statements ride on every result.

### Distinctions it keeps

- **A DEC is not an EPC.** A Display Energy Certificate is a measured
  operational rating; MEES uses the modelled asset rating. A DEC returns
  `not_supported` with no band, rather than being read on the wrong scale. So
  does a domestic certificate.
- **An expired certificate is not a low band** — it is the absence of a valid
  one, and it is checked before the band. Ten years from lodgement.
- **A band and a score can disagree**, and where the register publishes both the
  disagreement is reported, never resolved.
- **The urgent gap depends on the band.** A building at F has a letting problem
  today; the distance to a 2031 target is the lesser question. Both distances
  are reported, in BER points as well as whole bands.
- **The 1,000 m² test is a gross internal area of the demise.** An EPC floor
  area and a VOA area are different measurements, so a figure within 10% of the
  threshold returns "cannot determine which regime applies". Pass a measured
  area with `&area_m2=&area_basis=` — its source travels into the result.

### Fuel, and one claim not to overstate

The non-domestic rating is a CO₂ rate, so rooftop PV — which displaces purchased
electricity — does not move the band on a gas-heated building. That flag says
exactly that and no more: it is **not** a view on whether the roof is a good PV
site for bill savings or Scope 2 reduction. Two questions, two answers.
`pvCanMoveBand` exposes the narrow claim on its own.

## MEES prospects (S-08)

`/land/mees` screens the loaded non-domestic certificates and groups them into
cohorts. `/api/site-intel/prospects` serves the same thing as JSON, or as CSV
with `&format=csv`.

```bash
npm run epc:load -- certificates.csv     # bulk load, from the register's download
```

Filters: `?cohort=`, `?district=`, `?postcode=`, `?band=`, `?min_area=`,
`?max_area=`, `?gas=1`, `?limit=`.

### The corpus is the register, not the VOA list

S-07 searches VOA and attaches an EPC band by postcode — fine for a search
result, where the band is a lead. Not fine here: a prospect list **names a
building and states its band**, so a postcode-matched band would put a specific
address on a list of poorly-rated stock because its neighbour is. A certificate
carries the address, floor area, fuel and band in one record, so the claim comes
from a single row.

### One row per building

The register holds every certificate ever lodged. A building re-assessed from F
in 2015 to B in 2024 has two, and listing both would put it in two cohorts at
once. Only the most recent per building is screened — identity is UPRN, then the
register's building reference, then address and postcode — and the ones set
aside are **counted and reported**, not dropped.

### Coverage is what is loaded

`epc_certificate` is a cache filled by lookups and bulk loads, so a count here is
a count of what is held, never a count of what exists. That statement sits above
the results and in the first rows of every export.

### Cohorts, not a score

| cohort | criteria |
|---|---|
| Below the minimum band | F or G on the most recent valid certificate |
| Certificate expired | more than ten years since lodgement |
| Inside the proposed 2031 horizon | C/D/E, clearly above 1,000 m² |
| Regime cannot be determined | C/D/E, area unknown or within 10% of 1,000 m² |
| Meets the minimum, no further target | C/D/E, clearly at or below 1,000 m² |
| Meets the proposed 2031 target | A+, A or B |
| Could not be screened | no readable band |

There is deliberately **no prospect score**: a number blending band, area, fuel
and expiry would rank by a weighting nobody chose and be read as a measurement.
Membership is decided by S-05's screening, not by SQL, so the policy stays in one
file.

### What travels with a row

- **Exemption status unknown**, on every below-minimum row — not just the page.
  A building below EPC E with a registered exemption is lawfully let.
- **"Last known"** on an expired certificate's band. A 2015 G rating says what
  the building was eleven years ago.
- **The caveats go into the CSV** as visible rows, because a spreadsheet travels
  without the page around it. Each row also carries its own finding sentence and
  an explicit `exemption_status_unknown` column.

### Not a portfolio tracker

No lease data, so no trigger-year segmentation — EPC expiry is a third of that
calculation and a lease event usually comes first. This finds prospects; it does
not track a client's portfolio. See PRELAUNCH TICKET-12.

## Building footprints (S-01)

```bash
ogr2ogr -t_srs EPSG:4326 buildings.geojson Building.shp   # OS OpenMap Local
npm run site:load-buildings -- buildings.geojson
```

Resolving a building needs a footprint: it is what S-02 screens against, and
what the map draws. The store picks the polygon **containing the UPRN point**;
failing that, the **largest polygon intersecting the title extent**, flagged
`footprint_inferred`.

### It does not need PostGIS

An earlier version of this code said it did, and was wrong. Containment was
already in `geo.ts`; intersection is an orientation test over edges, exact for
simple polygons. Nothing scans the dataset — a bounding-box lookup returns a
handful of candidates and the exact test runs over those.

That mistake was expensive: PostGIS was never installed, so the store returned
nothing, so every profile reported `footprint: unavailable`, so S-02 had no
geometry and could not run from the UPRN search path at all. Migration 004 still
adds PostGIS columns where the extension exists; it is an optimisation, not a
requirement.

`containing()` orders by area **ascending** so the smallest containing polygon
wins — where a unit sits inside a larger terrace outline, the unit is the
answer. `largestIntersecting()` orders **descending** and returns the first
exact hit.

### Redrawing a footprint

`/land` has a **Redraw footprint** control beside Confirm. Click to place
corners, Undo point, Cancel, Save shape (enabled at three points — fewer is not
an area).

The published polygon is **kept**, and a second redraw replaces your shape, not
the original. That distinction matters: if each redraw overwrote the stored
original, "Revert to published" would quietly become "revert to my last shape" —
still there, still working, no longer doing what it says.

A drawing is a **T4 override**, and its area feeds the constraint screen and
anything reading floor area. So the figure carries a "your drawing" badge, and
the panel states what was published, where it came from, and how far the drawing
departs from it.

**Constraints screened before a redraw describe the previous shape**, so the
panel says so and offers to re-screen. It does not re-screen automatically — a
redraw is usually followed by another, and each re-run is a round of calls to
planning.data.

Reverting restores `footprint_inferred` if the original carried it: that flag
described the source polygon's provenance, and losing it would make the restored
polygon look better sourced than it is.

**A drawing survives searching for the site again.** Resolving a site builds a
profile from source data, which knows nothing about what you drew, so the stored
override is carried onto it. Only the override travels — address, LPA and
screening states are re-resolved on purpose, because the point of resolving
again is to get what the sources say now. The original kept is the one from when
you drew over it, under its own date, not today's published polygon under
today's.

The id a profile is stored under (`buildingIdFor`, `UPRN-<uprn>`) is shared by
the client and the server rather than spelled out at each end: a drift between
them would not error, it would quietly write a second row and lose the drawing.

A moved pin needs none of this, because Move pin stores a **UPRN rather than a
coordinate** — re-resolving by that UPRN gives the same position back from OS
Open UPRN.

### Move pin

Beside Confirm and Redraw. Click the building on the map and the pin moves to
the **nearest OS Open UPRN within 25 m** (resolution step (e)).

The click is a **pointer, not a coordinate**. What gets stored comes from OS
Open UPRN, so the profile's lat/lon always agrees with its UPRN. Beyond 25 m
nothing changes and the reason says so — silently keeping the old pin would
leave you believing the move worked. Where more than one UPRN is within range,
both are offered nearest-first with distances rather than one being picked.

A different UPRN is a **different building**, so everything hanging off the old
one — constraints, EPC, ownership, VOA, grid — is cleared rather than carried
across.

The mode is one-shot, and Move pin and Redraw disarm each other: one click
cannot mean both "place a corner" and "pick a building".

### Editing a shape, and snapping to corners and walls

**Edit shape** sits before Redraw, because the common correction is not "draw
this again" — it is "the published polygon is right except for one corner". It
seeds the editor from the existing footprint and produces the same T4 override,
because a footprint with a moved corner is no longer what OS published.

Handles say what they accept. A **solid** handle is a real vertex: drag it to
move it, alt- or shift-click it to remove it. A **hollow** one is a midpoint —
a place a vertex could go — and clicking it puts one there. Dragging a **wall**
moves the whole side, carrying both its corners.

The cursor comes from the same hit-test the press uses, so what it promises is
what you get: `move` over a corner or a wall, `copy` over a midpoint,
`crosshair` over open map.

**A wall move is rigid**: both corners travel by the same delta, so the wall
keeps its length and its angle. That is the whole reason to have the gesture —
dragging the two corners in turn is already possible and cannot help but change
the wall. The wall follows the pointer's own travel rather than jumping its
midpoint under the cursor, and snapping a dragged wall can only ever be a
translation: both ends are offered, whichever lands closest to a target wins,
and the whole wall moves to put that end on it. A wall clicks into place as
either of its corners meets a neighbour's.

A press on a wall is not immediately a drag. The midpoint sits on its wall, so
the press is held until the pointer travels a few pixels: below that it is
still a click, and a click on a midpoint inserts. Resolving it by position
instead — midpoint inserts, rest of the wall drags — breaks on short walls,
where the midpoint's grab radius covers most of the wall.

The two modes accept different gestures, so the hint names the one you are in.
A click on open map places a corner in a fresh drawing, and does **nothing** to
an existing ring — tacking a corner onto the end of a closed shape is never
what a click in the middle of the map meant. **Walls drag in edit mode only**:
while drawing, a click that lands on the line already placed has to stay a
corner, because a concave shape needs exactly that. Undo point is offered only while
drawing: in edit mode there is nothing of yours to undo, and the button would
chop a corner off the published ring under a label that says otherwise. A
corner cannot be removed at three points, and at three points the panel says so
rather than letting the gesture fail silently.

Clicking a corner you have already placed **grabs** it rather than adding
another on top. Closing a polygon by clicking its first point is a common
instinct — in most draw tools it is how you finish — and without the guard it
left a coincident duplicate.

**Snapping is measured in screen pixels, not metres.** A tolerance in metres is
generous zoomed out and unusably tight zoomed in: it would take the wrong
building at one zoom and refuse to snap at all at another. What you are doing
is "put this handle on that corner", which is a screen-space judgement, so the
threshold is one too — 12 px at whatever zoom is in force.

A vertex snaps to a neighbour's **corner**, or failing that to a point anywhere
along one of its **walls** — which is the normal case for a terrace, where the
party wall runs the length of the building and the corner you want has never
been published. A snapped wall point lands *exactly* on the wall as stored: the
perpendicular is taken on screen, where you are aiming, but the point is then
placed at that fraction along the wall's own coordinates, so the two polygons
share a line rather than disagreeing by half a metre.

Walls are a **tighter** target than corners — 8 px against 12 — and it is not a
taste judgement. A corner is a point you aim at; a wall is a line you cross,
and walls cover far more of the map, so at equal tolerance a vertex dragged
across a street would stick to every wall it passed. Keeping the wall threshold
lower also means a wall snap can never land on a corner: any corner that close
was already claimed by the corner rule.

**A corner in range always beats a wall in range**, and not merely because it
is usually nearer. Close to a corner the foot of the wall is almost exactly the
corner too, so "nearest wins" would have the point stick to the wall a hair
short of the corner you were plainly aiming at.

Candidates are the corners of **neighbouring buildings**, drawn faintly under
the shape, fetched from `/api/site-intel/buildings`. Deliberately **not this
shape's own corners**: dragging one onto the corner beside it collapses the
edge between them into nothing, and the gesture that would do it — nudging a
corner a short distance — is the commonest there is. It costs nothing either,
because the site's own published footprint is in the neighbour list already.

A snapped handle jumps, so the target is **ringed in blue while the snap
holds** — a handle that moves to a coordinate you did not choose, with no
explanation, reads as a bug. A corner snap explains itself: there is a visible
corner under the ring. A wall snap does not, so the **whole wall lights up**.

Snapping does **not** change provenance. A shape built entirely from OS
vertices and walls is still a user drawing at T4, because you chose which ones
and in what order. The panel says so under the checkbox.

With nothing to snap to, the reason is given, because "no buildings near this
site" and "no building polygons loaded at all" call for different things: the
route reports both the nearby count and the loaded total.

The geometry lives in `src/lib/site-intel/draw.ts` — a leaf module with no
React and no MapLibre, so rings, midpoints, insertion, removal, wall moves,
snapping and hit-testing are tested without a browser. The component owns the
pointer events and supplies the projection.

### Reproject first — the loader will stop you

OS publishes OpenMap Local in **British National Grid (EPSG:27700)**, in metres.
A BNG file loaded unconverted does **not** error: it produces polygons at
longitude 400000, which fall outside every query and silently match nothing —
the store looks loaded and answers null to everything.

So the loader range-checks coordinates and stops on the first bad feature with
the `ogr2ogr` command in the message. It refuses two ways with different
reasons: coordinates too large for lat/lng ("this looks like British National
Grid"), and valid lat/lng outside the British Isles ("check the file and its
projection"). No datum shift is attempted here — OSTN15 is a grid
transformation, not a formula, and an approximate one would move buildings by
metres.

Files are streamed line by line, not parsed whole: a local-authority extract
runs to hundreds of MB.

`npm run site:verify` reports the polygon count, and says what zero costs.

## Constraint map layers (S-02)

Screened constraints are drawn on the map at `/land`, in three layers:

| layer | meaning | style |
|---|---|---|
| on the site | the polygon intersects the building | solid outline, 0.3 fill |
| nearby | within the 50 m buffer, **not** on the site | **dashed** outline, 0.1 fill |
| area searched | what the proximity pass actually queried | grey dashed, no fill |

Grouped into Heritage, Designated land, Ecology, Flood and Other, each with a
toggle. Clicking anywhere lists **every** constraint at that point — a large
designation would otherwise shadow the smaller, more specific one underneath it.

### A map that draws nothing looks like open country

That is why the layers come with a coverage line above them, not a footnote:

> 2 drawn on the site, 3 nearby · 1 flagged but published no extent to draw —
> **15 COULD NOT BE CHECKED**, so an empty map is not an all-clear.

The panel's empty list prompts "did it look?". A map has no empty list, so the
strip has to say it. The datasets behind that number are named. Toggling a layer
off filters the map and **does not** change those counts — hiding a layer must
never make the map claim something was not checked.

Two other things it admits: the **search envelope is a bounding box**, not a
true buffer, so its corners reach further than 50 m — and it is drawn, rather
than leaving you to picture a circle. And a constraint whose source published
**no extent** is counted separately: it is real, it is in the panel, and there
is simply nothing to draw.

```bash
node fixtures/planning-data-stub.mjs        # invented fixture geometry
PLANNING_DATA_BASE=http://localhost:3900 npm run dev
```

## Grid capacity (S-03)

```bash
npm run grid:boundaries -- <neso-dno-areas.geojson>   # which DNO, by containment
npm run grid:verify                                   # probe datasets, print config
npm run grid:ingest                                   # pull heatmap + ECR
```

`/api/site-intel/grid?uprn=` (or `?lat=&lng=`) returns the DNO, the substations,
the ECR summary and the two screens. The site panel shows all of it.

### Which DNO is a containment question

It used to be answered by whichever substation was nearest. That is a different
question with a frequently different answer — licence areas are administrative
boundaries, and a site near one can have its nearest substation across it. Now
it is point-in-polygon against the NESO DNO licence-area boundaries, with the
version date stored.

Ray-cast in TypeScript rather than PostGIS (there are ~14 areas, and PostGIS
stays optional). Holes are honoured: a licence area can enclose another, and a
point inside a hole is *outside*. An area that does not map to a known DNO is
stored with a null id and reported — **a wrong DNO on a connection enquiry is
worse than none**. If two polygons contain the same point, that is reported too
rather than resolved by whichever row came back first.

### Substations: containment first, then labelled proximity

A DNO's own supply-area polygon containing the site wins. Otherwise the nearest
5 within 10 km, **labelled `nearest_by_distance`**, with the sentence explaining
that proximity does not mean a substation would serve the site. Where the DNO
publishes its own RAG the ingest keeps it; where it does not, the row says "RAG
is our screening band, not the DNO's".

### Unrated is a fourth state

The PV export and electrification screens output green / amber / red / **unrated**.
Unrated means the input has not been supplied — "an absence of assessment and
not a favourable result". It is shown with its own visible treatment, because
greying it out would let a reader infer a pass. A test asserts the explanation
contains no reassuring word.

### Freshness is the publisher's date

Staleness (90 days, from the brief) is measured against the DNO's published
source date, falling back to our ingest date only when the publisher states
none — fetching old data today does not make it fresh. Past the window the tier
becomes `stale` and an amber warning shows; the figure is not withheld, because
an old number that says it is old beats a gap.

### The fixed wording

Every grid output carries it, last and unconditionally, from the config:

> Indicative only — based on published DNO data dated [date]. Not a connection
> offer. A connection application to [DNO] is required.

### Map layers

Three, alongside the S-02 constraint layers (brief §5.5):

| layer | meaning |
|---|---|
| supply area | the DNO's own polygon, where one is published — usually absent |
| register entries | ECR generators, coloured by technology, sized by export capacity |
| substation ring | which substations this site's screening actually used |

**Connected is filled, accepted is hollow.** An accepted connection is not
generating yet, and drawing them alike states something false about the network
as it stands — the same rule as `present` vs `proximity` in S-02.

The legend leads with what a register entry *is*, and every ECR popup repeats it:

> These are generators already connected or accepted for connection. They show
> what the network has absorbed, **not what is left** — a cluster is not evidence
> of available capacity.

That sentence is duplicated on purpose. Dots around a site invite two wrong
readings — "there's capacity here" and "others got connected, so I can" — and
the first is close to the opposite of what the data says.

Two things are deliberately **not** drawn: the DNO licence-area boundary (county
-sized, so at building zoom it is an edge-to-edge wash carrying no information —
the panel states it in words), and any "capacity available" layer, because no
such figure exists in this data.

The S-02 fit is a ~50 m envelope and the register radius is 2 km, so one frame
cannot serve both. The site fit wins and the grid legend offers **"Zoom to the N
register entries — most sit outside this view"**: saying they are off-screen beats
letting their absence read as "none nearby".

Entries the publisher left without coordinates are counted separately and named
— they are invisible to every radius search, so deriving that count from the
search results would give a number that is structurally always zero.

### G98/G99 are null on purpose

Brief §5.4 requires the threshold values in config. They are there as `null`,
marked `verified: false`. They are not in the brief or in any bundled reference,
and a connection threshold written from memory is a wrong answer about someone's
grid application. Null fails loudly. Nothing reads them — the PV export screen is
unrated until a PV design module supplies an AC export capacity (a G99
application is made on kWac, not kWp). See PRELAUNCH TICKET-14.

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
db/migrations/       schema; 004 is an optional PostGIS upgrade
src/ingest/          registry (slugs, licences, attribution), ODS client,
                     field normaliser, verify/ingest CLI, DNO boundary loader,
                     adapters/ (DnoAdapter interface, CKAN for NGED),
                     cli.ts (entry-point guard so helpers stay importable)
src/lib/             db pool, types, headroom RAG bands, fixed grid wording,
                     base map config, geo-polygon (containment, distance)
src/lib/site-intel/  S-01: models, sources.yaml, geo, planning.data client,
                     resolution chain, profile builder, stores, service
                     S-02: constraint_rules.yaml, constraints, flood,
                     constraint-layers (map categories + coverage)
                     S-04: ownership matching, Companies House
                     S-06: VOA assessments, floor area, use class
                     S-05: performance (bands, validity, fuel),
                     mees_rules.yaml + MEES screening
                     S-07: query parser, SQL executor, run description
                     S-08: prospect cohorts, dedupe, coverage
                     S-03: grid_rules.yaml, screening, site grid lookup,
                     grid-layers (map technologies + coverage)
                     Task 0: EPC register client and cache
PRELAUNCH.md         tickets that block a client release
tests/               unit tests + fixtures (constructed, not recorded)
scripts/             MapLibre worker staging
src/app/api/         /api/substations (bbox + filters), /api/health,
                     /api/site-intel/* including /search
src/components/      LandMap, SitePanel, SiteSearch, MeesProspects
fixtures/            sample substations, EPC certificates, DNO licence areas,
                     building footprints and a planning.data stub — all
                     invented, not DNO, NESO, OS, register or planning.data
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
| `npm run grid:boundaries -- <geojson>` | Load NESO DNO licence areas for point-in-polygon |
| `npm run planning:stub` | Serve invented constraint geometry on :3900 for offline work |
| `npm run maplibre:worker` | Re-stage the MapLibre worker into `public/` |
| `npm test` | Unit tests (no network required) |
| `npm run site:verify` | S-01 readiness: reference data, slugs, attributions |
| `npm run epc:verify -- <postcode>` | Task 0: check both EPC hosts |
| `npm run site:load-uprn -- <csv>` | Load OS Open UPRN or ONSUD |
| `npm run site:postcodes` | Derive postcode centroids from loaded UPRNs |
| `npm run site:load-buildings -- <geojson>` | Load OS OpenMap Local footprints (reproject to EPSG:4326 first) |
| `npm run site:load-ccod -- <csv>` | Load HMLR CCOD or OCOD ownership data |
| `npm run site:load-voa -- list\|smv <csv>` | Load VOA rating list or summary valuations |
| `npm run epc:load -- <csv>` | Bulk-load EPC certificates from the register's download |

## Caveat

MEES and EPC outputs are **screening flags for review by a qualified person, not
a compliance determination.** MEES applies to a letting, not a building, and the
PRS Exemptions Register is not held here. The EPC B standard for 2031 is
proposed and requires secondary legislation; there is no EPC C requirement. All
wording is unapproved — see PRELAUNCH TICKET-09.

Grid figures are **indicative only, based on published DNO data. Not a
connection offer.** A connection application to the relevant DNO is required.
Headroom is network capacity in MVA — it is not a site's agreed supply capacity
in kVA, which is held per-MPAN and arrives with phase 3. Screening flags are for
review by a qualified person.
