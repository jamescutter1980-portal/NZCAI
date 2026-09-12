# Plan: implementing the missing APIs

Written 10 September 2026, from the live registry (111 sources) and the connector notes. Companion to `api-gap-analysis.md`, which describes the current state; this describes the work to close it.

## The honest framing

"Missing APIs" means two different things, and the larger one is not the one it looks like.

| | Count | What it means |
|---|---|---|
| Built connectors never exercised against the live service | 82 | Code and tests exist, written from documentation. Not one has made a real call. |
| Sources with no connector at all | 29 | Registered with access notes and links only. |

**The 82 are the bigger gap.** A connector that has never spoken to its service is not implemented in any sense a user would accept: the response shape is a guess, the auth is a guess, and the first real call is where that gets discovered. No amount of new connectors improves this.

Of the 29 with no connector, only about half are engineering work:

| Category | Count | Blocked by |
|---|---|---|
| Buildable now, nothing needed but code | 8 | Nothing |
| Buildable after a free registration | 6 | You register, then code |
| Commercial contract required | 9 | A purchasing decision, not engineering |
| The client's own account required | 2 | Client authorisation |
| No API exists at all | 4 | Nothing to build; the work is an import or a manual route |

So the engineering backlog is 14 sources, not 29. Fifteen are decisions or dead ends, and the plan should not pretend otherwise.

---

## Phase 0 — Verify the 82. Do this before building anything new

**Why first.** Every connector below reuses the same framework, helpers and conventions as the 82. If those conventions are wrong against real services, the wrongness is currently duplicated 82 times and would be duplicated further by every connector added. One verification pass either confirms the pattern or corrects it once.

**Effort.** The first sitting is under an hour. The 26 open sources need no keys at all.

1. `cp .env.example .env.local`, `pnpm dev`, open `/sources`, click **Run all health checks**.
2. Expect the 26 keyless connectors to answer: postcodes.io, Planning Data, Land Registry, Carbon Intensity, Elexon, NESO, National Gas, UKHSA, PVGIS, PV_Live, the seven Environment Agency APIs, DEFRA UK-AIR, GBIF, Resource Watch, DfT traffic, Contracts Finder, Nomis, ONS, Ökobaudat.
3. Run one operation per source with a real input and compare against the provider's own website.
4. Where a response differs from the fixture, paste the real response into the fixture and fix the row mapping. This is the expected outcome for several, not a failure.
5. Flip each verified source's `status` to `live_verified` and delete the notes that no longer apply.
6. Then work the 56 keyed connectors in the order below.

**Key acquisition, in value order.** Free and quick: Companies House, Charity Commission, Open Charge Map, Met Office DataHub, NBN Atlas, OS Data Hub (OpenData plan). Application with review: DVLA Vehicle Enquiry, DVSA MOT. Already held or nearly: n3rgy, EPC (needs the new GOV.UK One Login token). Paid: Google Solar, Solcast, Climatiq, OS Places.

**Deliverable.** The verification log at the end of `api-gap-analysis.md`, filled in. That table is the real measure of progress, not the connector count.

---

## Phase 1 — Eight sources buildable now, nothing needed but code

These need no key, no contract and no registration. Each follows a pattern already built and tested in this repo, so the risk is low and the reuse is high.

| Source | What it unlocks | Pattern to reuse | Size |
|---|---|---|---|
| **OS Open UPRN** | The UPRN spine. A UPRN joins EPCs, OS Places, NGD buildings, planning entities and the client's own asset list. Today an asset without a UPRN cannot be matched across sources. | The streaming loader built for Scottish EPCs and DESNZ postcode data | Medium |
| **EA water-stressed areas** | Water stress by water-company area for England, which is the right measure for a UK site. Aqueduct is a global fallback. | Small reference table plus a postcode match | Small |
| **ENA embedded capacity register** | Cross-DNO connected and contracted generation. Completes grid headroom screening, which currently only covers the DNOs with open portals. | The existing Opendatasoft and CKAN helpers | Medium |
| **MCS installations** | Local renewable uptake for benchmarking. Aggregate only, never per building. | Reference loader | Small |
| **EXIOBASE** | Open spend-based Scope 3 factors, removing the dependency on Climatiq for category 1 screening. | Reference loader, but the release is several GB, so a precomputed GB intensity table is the sane import | Large |
| **VOA rating list** | Floor area by floor and use class for England and Wales, filling the single biggest hole in asset data. | Streaming loader | Medium |
| **Flood Maps NI** | Flood screening for Northern Ireland, currently unscreenable. | WMS or geodatabase import; needs a service URL captured from the viewer first | Medium |
| **NI historic environment** | Heritage constraints for Northern Ireland. | ArcGIS or WFS point query, once a service URL is confirmed | Medium |

**Sequencing.** OS Open UPRN first: it is the join key everything else benefits from, and it makes the EPC, OS and planning connectors materially more useful once they are verified.

**One licence caveat.** VOA data is not Open Government Licence. It is usable for your own purposes; redistribution or building a competing product with the raw data is restricted. That constrains what may appear in a client deliverable and should be checked before the import, not after.

---

## Phase 2 — Six sources needing a free registration

You register, I build. Each is a genuine capability the portal cannot fake.

| Source | Registration | What it unlocks |
|---|---|---|
| **Copernicus CDS** | Free ECMWF account, then accept each dataset's licence in the web UI | ERA5 reanalysis for weather normalisation without a commercial plan |
| **HadUK-Grid via CEDA** | Free CEDA account plus an access token for scripted use | 1991-2020 climate normals per site, the proper baseline for degree-day normalisation |
| **UKCP18** | Free registered account on the UKCP interface | Future overheating and adaptation analysis, which the portal cannot currently do at all |
| **BECD** | Free registration | UK product and building embodied carbon, replacing the ICE database which goes educational-only on 30 September 2026 |
| **ENCORE** | Free registration | Sector nature dependencies for TNFD LEAP |
| **SBTi targets** | None; the XLSX export is public but its licence restricts redistribution | Supplier climate commitments. The search operation already exists and reads a CSV you save from the export |

**Two are asynchronous.** Copernicus and UKCP return queued jobs that can take minutes to hours and deliver NetCDF or GRIB. They belong in a scheduled batch job, not a request cycle, and NetCDF needs a parser the portal does not have. Budget for that, or restrict the scope to precomputed extracts per site.

**BECD is time-sensitive.** ICE stops being usable commercially on 30 September 2026. If embodied carbon matters to your deliverables, BECD or a paid alternative needs to be in place before then.

---

## Phase 3 — Nine commercial sources: decisions, not engineering

These are procurement choices. I can build any of them in roughly a day once credentials exist, but building them is not the bottleneck and cannot start without a contract.

| Source | What it buys | Ask before signing |
|---|---|---|
| **Perse** | Address-level meter, EPC and consumption linkage across the UK | Sample responses; whether the 30 million address and UPRN-to-MPAN claims hold for your portfolio |
| **ElectraLink QuoteRight** | Consented MPAN details and estimated annual consumption | Whether you can hold the accreditation; every lookup needs a Letter of Authority |
| **Xoserve** | MPRN annual quantity and supply-point data | Whether you qualify directly or must go through RECCo; the Gemini gateway is for shippers and is not a building data product |
| **JBA** | Flood depths and scores including climate scenarios | Whether derived results may appear in client dashboards and reports |
| **Groundsure** / **Landmark** | Contaminated land, ground stability, climate risk per property | Whether structured data is available or only ordered reports; report-only kills automation |
| **IBAT** | Protected areas and Red List species proximity for TNFD | Permitted outputs; some licences forbid showing the underlying data |
| **ecoinvent** | Life-cycle inventory for embodied carbon gaps | Redistribution: the licence forbids publishing dataset-level values, so only aggregated client results may appear |
| **GRESB** | Submission and retrieval workflows | Which functions the API exposes for the client's entitlement |

**My recommendation if you buy one.** Perse or ElectraLink, because measured consumption coverage is the constraint on everything downstream: carbon, CRREM, EUI, benchmarking. A flood or ground product is a per-report cost you can defer to the deals that need it.

**The redistribution question matters more than the price.** Four of these nine have licence terms that restrict what may appear in a client deliverable. That determines whether the integration is worth building at all, and it is the first thing to establish, not the last.

---

## Phase 4 — Four with no API to implement

Not engineering. Being honest that these stay manual is more useful than a connector that pretends otherwise.

- **NI EPCs.** No JSON API, no bulk download, no public dataset. Certificates are a web search by postcode or reference, returning PDFs, and owners can opt out of address search. The realistic route is manual lookup with the result recorded against the asset.
- **Ofgem Renewable Electricity Register.** Public reports only partly restored since the May 2025 replacement. Extracts come by emailing `renewable.enquiry@ofgem.gov.uk` with the supplier and compliance period. Treat as an evidence request in the market-based Scope 2 workflow.
- **Heat network zoning.** The Heat Networks and Zones Service launched in beta in 2026 with a searchable map; programmatic access is unconfirmed. Record zone status per asset manually until an API appears.
- **EA LIDAR.** Tiles download by area and need a raster toolchain outside this portal. Google Solar already gives roof segments where it has coverage and is the quicker route per building.

**Measurabl and MOSL** sit next to these: both need the client's own account or a controlled data request, so they start with a client conversation rather than code.

---

## What I would actually do, in order

1. **Phase 0, first sitting.** Health-check the 26 keyless connectors and fix what the real responses disagree with. This is the highest-value hour in the whole plan and it needs your machine, not mine.
2. **Load the reference data.** `data/reference/` is empty, so every factor-based figure currently returns "unavailable". DESNZ factors and the AIB residual mix take minutes and turn the carbon engine on.
3. **Phase 1, OS Open UPRN.** The join key that makes the verified connectors worth more together than apart.
4. **Register for BECD** before ICE goes educational-only on 30 September 2026.
5. **Decide on one commercial consumption provider.** Everything downstream is gated on measured data coverage.
6. **Phase 1 remainder and Phase 2**, in the order your client work demands them.

## What could go wrong, and what it would cost

- **The response shapes are wrong at scale.** Plausible: several connectors were built from third-party client code rather than official specification. Mitigated by the fixture pattern, so a fix is a fixture swap and a mapping change, not a rewrite. Phase 0 finds this cheaply.
- **A shared helper is wrong.** The ArcGIS, WFS, WMS and CKAN helpers are used by many connectors each. A fault there is one fix but a wide re-test. This is an argument for verifying one connector per helper family early rather than 26 of the same kind.
- **The EPC service moved again.** The API was replaced once already in May 2026. If the token flow differs from the OpenAPI document, that connector needs rework before the identity phase is useful.
- **Licence terms kill an integration after it is built.** Avoided by asking the redistribution question during procurement, before any code.

## What this plan does not include

Non-metered fuels (oil, LPG, biomass), which would close another SECR exclusion cheaply on the pattern already proven four times; user accounts and Postgres, which stand between this and more than one person using the portal; and NetCDF parsing, which Phases 2's climate sources need. Each is portal work rather than an API integration, so they belong on a separate list.
