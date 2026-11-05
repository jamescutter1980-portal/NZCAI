# UK NZCBS alignment: gap analysis and build plan

Written 5 November 2026 against **UK Net Zero Carbon Buildings Standard, Version 1, Rev 1 (April 2026)** and **Submission Proforma v1 rev03 (April 2026)**, using the section extracts and limit tables bundled in the `nzcbs-standard` skill. Companion to `assets-and-carbon.md` (what the assessment engine does today) and `api-implementation-plan.md` (the data-source plan).

The goal set for this work: mirror the Standard on every building in NZC AI and the NZC Portal, and auto-produce an evaluation that is ready for submission to a verifier.

> **Gate.** Everything in section 5 changes the NZC Portal app and needs Iain's verification before any of it is built. This document is the proposal for that review. Nothing here has been started.

---

## 1. The honest summary

**What the portal has today** is one indicative check: metered import kWh over floor area, compared with an operational energy limit from a CSV the user transcribes themselves. The CSV is empty in every deployment, so the check currently returns "not assessable" for every building. The MCP layer mirrors the same check with caller-supplied values. That is the whole of the NZCBS coverage.

**What the Standard assesses** is ten aspects (5.1 to 5.10), with classification rules (section 4) that decide which limits apply, submission requirements for each aspect, a verification lifecycle (section 6), and strict rules on what may be said about a building (section 7). Of those ten aspects the portal partially touches two: operational energy (one metric, wrong scope, wrong carbon basis) and refrigerant leakage (the quantity-added approach, with no system register and no GWP check).

**What "ready for submission" can mean.** The Standard is measured-data only (4.3): claims are verified on complete, occupied buildings over a twelve-month Operational Reporting Period. The portal's strength is exactly that data: half-hourly meters, consents, provenance on every value. So the portal can produce a complete **submission pack**: the populated rev03 proforma, an evidence report covering every submission requirement list, and the underlying readings and records. What it cannot produce, and should never pretend to:

- the embodied carbon assessment itself (a RICS PS whole life carbon assessment by a competent assessor; the portal imports and checks the result),
- the Retrofit Plan for the stepped route (PAS 2035 or 2038, by a qualified retrofit coordinator),
- drawings, schematics, servicing records, occupancy surveys (uploaded as evidence),
- verification (an approved verifier, through NZCBS Ltd).

**Claims language is a hard constraint.** Section 7.4.1 forbids "compliant with", "certified to" and "aligned with" before verification, and 7.5 prohibits implying alignment. The only permitted pre-verification phrase is "targeting verification to the UK Net Zero Carbon Buildings Standard". Today's UI labels rows "pass" and "fail" and the marketing log describes an "indicative check"; both survive, but the pack and the UI must never call a building aligned. That rule shapes the product: the portal is a **pre-verification evidence engine**, not a certifier.

---

## 2. Gap analysis by requirement

Severity means what it does to a submission: **Blocker** (no submission possible without it), **Gap** (submission incomplete or wrong for some buildings), **Advisory** (quality or convenience).

### 2.1 General principles (section 4)

| Ref | What the Standard requires | What the portal has | Gap | Severity |
|---|---|---|---|---|
| 4.1.2 | Rev 1 limits and the 5.1 to 5.10 structure | A generic CSV schema with invented metric keys; no file loaded anywhere | The Rev 1 tables are not loaded, and the schema cannot express works type, building type, route, NIA basis, region or subsector | Blocker |
| 4.2.1 | Classify the building (New or Existing) and each works programme (New, Retrofit, Reportable, Non-Reportable) by the Table 4 and 5 tests | Nothing | No building or works classification | Blocker |
| 4.2.2 | Sector and subsector per floor area; Mixed-Use rules; buildings with 30% or more unclassifiable NIA cannot claim | One free-text property type per asset | No sector areas, no subsector, no Mixed-Use, no unclassifiable test | Blocker |
| 4.2.3 | Scope of assessment is the whole site and works | Asset is one record with meters | Adequate for single buildings; multi-building sites need prorating | Gap |
| 4.2.4 | Reporting Period End Point; ORP is the twelve months before it; ERP is five years before it or since the last RPEP | Calendar, financial and rolling twelve-month periods | No RPEP on the asset. The rolling period helpers can serve as the ORP once an RPEP is stored | Gap |
| 4.2.5.2 | Equation 1a (sector-weighted limit by NIA share) and 1b (new and existing area weighting by GIA share) | Nothing | Needed for every Mixed-Use building and every building with 10% to 50% new area | Blocker for those buildings |
| 4.2.6 and 5.2.7.1 | Limit year: New Buildings use the Date of Commencement of the New Works or 2025; Existing one-go route uses the latest Retrofit Works commencement or 2025; stepped route uses the ORP start year | "Year" is the reporting year | Limit year is chosen wrongly for every building type | Blocker |
| 4.2.7 | Address and UPRN; GIA and NIA; area per sector; Table 7 sector-specific information (bedrooms, pupils, occupied hours, kW IT, refrigeration area, lab metrics, internal volume) | Address, UPRN, one floor area | No NIA, no footprint, no sector-specific fields | Gap |
| 4.3 | Three approaches: whole-building, landlord-only (Annex F2), tenant-only (Annex F3) | Shared-meter allocation shares exist | No approach selection; Annex F delineation absent | Gap (later phase) |

### 2.2 Embodied carbon (5.1)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.1.2 to 5.1.5 | Every New, Retrofit or Reportable Works programme completing in the ERP is assessed to RICS PS, up to five per submission (Works-1 to Works-5 sheets), with material quantities, carbon factor sources, uncertainty factors and the Box number from the carbon data flowchart | Nothing | The portal cannot compute this. It needs to **import** a completed assessment per works programme and carry it into the proforma | Gap |
| 5.1.6.1 and 5.1.6.2 | Upfront carbon vs Tables EC-1 (New Works), EC-2 (Retrofit), EC-3 (Reportable, Cat A+B or Cat B only, by the 80% rule) by commencement year | Nothing | Limit lookup and comparison | Gap |
| 5.1.6.4 | PV upfront carbon vs 750 kgCO2e per kWp | Nothing | Small | Gap |
| 5.1.6.3 | Life cycle limits: none in V1, but reporting is required | Nothing | Reporting field | Advisory |

### 2.3 Operational energy (5.2)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.2.1.2 | All energy from all supplies: grid electricity, gas, bulk fuels (oil, LPG, biofuels) from stock and deliveries, district heat including the network's generation and distribution energy, on-site renewable electricity and heat **used by the building**. Exclusions: industrial process, external works, submetered car parks and EV charging | Electricity and gas import meters only | No on-site generation used on site, no bulk fuels, no district heat, no exclusion handling | Blocker |
| 5.2.1.3 | Additional Uses up to 30% of NIA, submetered, assessed but exempt from limits | Nothing | Additional-use areas and their submeters | Gap |
| 5.2.2 | Pass/fail metric is EUI per m² GIA, or per m² NIA for Offices (and Schools, Sport and Leisure alternatives); PUE for Data Centres; Healthcare follows the NHS Net Zero Building Standard. Reporting metric is operational carbon intensity per m² | EUI per the asset's single floor area | No GIA versus NIA choice, no PUE, no sector reporting metrics (per bedroom, per conditioned area, per common parts area) | Blocker |
| 5.2.3.2 to 5.2.3.4 | Operational carbon uses generation **plus** T&D **plus** WTT generation **plus** WTT T&D from the DESNZ full set. Time-of-use factors allowed if T&D and WTT are added and the method is declared. REGO or supplier factors must not be used | Generation and T&D as separate Scope 2 and Scope 3 lines; half-hourly regional intensity stored and matched; no WTT lines | Add the two WTT lines and an "NZCBS basis" total distinct from the GHG Protocol totals. Both must stay visible: the Standard's figure is broader than Scope 2 location-based | Gap |
| 5.2.3.5 | On-site renewable electricity used on site has a factor of zero; exported electricity uses grid factors only for module D | Nothing | Follows from generation metering | Gap |
| 5.2.3.1 | Meter readings for grid supplies; stock and deliveries for bulk fuels; heat meters for networks | Half-hourly smart-meter readings, CSV import | Bulk fuel deliveries and heat meters have no home | Gap |
| 5.2.5 | Occupancy rate (Equation 4) at least 80% on day one of the ORP, from fitted-out, heated, energised, used spaces; operational-only buildings must be operational | Nothing | Occupancy record per asset with the four tests per separately occupiable space | Blocker |
| 5.2.6 | Submission: schematics; totals and per-fuel breakdown; excluded energy; statement of measurement method; readings; carbon with factors; additional-use split; occupancy data; Retrofit Plan if stepped | Readings and carbon CSV exports | The evidence report and most of its sections | Blocker |
| 5.2.7 and Table 12 | Particular uses (cinemas, server rooms over 100 kW, labs, gyms, catering) reclassified for limit-setting | Nothing | Part of the sector-areas model | Gap |
| 5.2.7.1 | Existing Buildings choose the one-go route (Table OE-2) or the stepped route (Table OE-3, interim limits, Retrofit Plan obligation); New Buildings use OE-1 | Nothing | Route selection and the Retrofit Plan obligation | Blocker for Existing Buildings |
| 5.2.8 | Retrofit Plan to PAS 2035 or 2038 with TM54-style modelling and embodied carbon for planned works | Nothing | Upload and checklist only; the plan itself is human work | Gap |

### 2.4 On-site renewable electricity (5.3)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.3.1.2 and 5.3.2 | PV, wind and hydro on the consumer side of the primary meter. Report total generation, used on site, exported, and capacity in kWp per m² footprint. Exported electricity is excluded from EUI and included against the target | Meters carry an export direction but nothing reads it; no generation meter, no footprint | Generation metering (total and export, used on site by difference), building footprint, capacity | Blocker for the target |
| 5.3.5.1 and Annex A3 | Target by region: 30, 45 or 40 kWh per m² footprint per year (60, 75, 65 for Homes and Storage and Distribution). Reduction by Equation 5 for evidenced constraints, by 15% for reused systems, to the in-scope electricity limit where lower; no target below 1 kWp (homes) or 4 kWp | Nothing | Region on the asset, constraint record with unconstrained area, target calculation | Blocker for the target |
| 5.3.4 | Submission: capacity, used on site, exported, method statement, constraint evidence | Nothing | Evidence report section | Gap |

### 2.5 Operational water (5.4)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.4.2 and 5.4.3 | Annual m³, m³ per m² GIA, carbon per m² GIA using DESNZ water supply and treatment factors; litres per person per day (Homes, Offices), m³ per pupil (Schools), WUE (Data Centres). Treatment applied to full consumption unless metered or on-site disposal | Water supply and treatment rows with DESNZ factors, optionally linked to an asset | Per-asset NZCBS metrics, source breakdown (network, ground, rainwater, greywater), the sector denominators | Gap (no limits, reporting only) |

### 2.6 Fossil fuel free (5.5)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.5.4 and 5.5.5 | A statement that there is no fossil fuel or first-generation biofuel use on site beyond the allowable cases (emergency and life safety, Class IV back-up, data-centre back-up with no alternative, scientific processes, construction, excluded uses). Biofuels need feedstock, origin, certification and chain-of-custody evidence | A gas meter on the asset implies a fail, but nothing says so | A fossil fuel systems register per asset: system, fuel, exception claimed (the proforma's own menu), evidence. A gas or oil supply with no allowable exception is a fail that the portal should state plainly | Blocker |

### 2.7 Electricity demand management (5.6)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.6.2 and 5.6.3 | Buildings over 500 m² GIA with half-hourly data: top ten demand values, 50th percentile and 1st percentile in kW, across the whole ORP | Half-hourly kWh readings are stored | Simple statistics over existing data (kW is twice the half-hour kWh) | Gap, and the cheapest win in this list |

### 2.8 District heating and cooling (5.7)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.7 | Heat meter at the connection; carbon content of heat vs a limit derived from that year's grid factor; network energy allocated to the building; network decarbonisation plan where fossil heat remains | Nothing | Heat meter readings, network record, carbon content calculation | Gap (only for connected buildings) |

### 2.9 Space heating and cooling delivered (5.8)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.8 | New Buildings, and Existing Buildings from 2040 or where heat meters exist: annual space heating and cooling per m² GIA and peak W per m²; limits for Homes and Commercial Residential only (Table OE-4); VRF by submetered electricity and efficiency | Nothing | Heat meter data model and the Homes limits | Gap (sector-dependent) |

### 2.10 Refrigerants (5.9)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.9.1.2 and 5.9.6 | Every in-scope system: type, refrigerant, charge, install date. GWP of each system's refrigerant vs 677 kgCO2e per kg, with two exceptions and a leak-detection obligation where exceeded | Refrigerant top-up rows with a gas name | No system register, no charge, no GWP limit check | Blocker |
| 5.9.3 | Where total charge is 3,000 kgCO2e or more: leakage by change-in-quantity (Equation 9a) or quantity-added (Equation 9b), times GWP from the DESNZ full set | Quantity-added only, per row | Threshold test, start and end charge option, per-refrigerant totals | Gap |
| 5.9.5 | Servicing records and inspection reports per system | Evidence text field | File evidence | Gap |

### 2.11 Carbon offsetting (5.10)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 5.10 | Optional. If used: credits from ICROA or ICVCM programmes, vintage within five years of the RPEP, retired for these emissions; or renewable procurement that is UKGBC Silver or Gold, a Deep Green REGO-backed tariff, or a qualifying PPA. T&D and WTT must be credits, never procurement | Supplier factor and evidence per meter | Offset register and the "(plus offsets)" claim variant | Advisory (optional aspect) |

### 2.12 Verification and communication (sections 6 and 7)

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| 6.2 | Register the building, predict the RPEP, submit through the proforma, verify after the RPEP, reverify annually for two years then every one or three years, submit data annually to the NZCBS online platform in the three-year pattern | Nothing | A submission lifecycle per asset: registered, RPEP set, evidence complete, pack generated, submitted, verified, claim period, next RPEP due | Gap |
| 7.2 and 7.4.2 | Any claim states the version, building and works types, sectors, RPEP, ORP dates and the limit year | Nothing | The pack's cover statement | Gap |
| 7.4.1 and 7.5 | No "aligned", "compliant" or "certified" before verification; only "targeting verification to the UK Net Zero Carbon Buildings Standard" | Disclaimer text; rows labelled pass and fail | Replace pass and fail labels with "within limit" and "above limit", add the permitted phrase, and never use the Standard's logo or mark | Gap (legal risk, small code) |

### 2.13 Annexes

| Ref | Requirement | Portal today | Gap | Severity |
|---|---|---|---|---|
| Annex A | Limit tables EC-1 to EC-3, OE-1 to OE-4, the NIA alternatives, A3 renewables, A4 GWP, PV embodied carbon | Nothing loaded; schema cannot hold them | Load the Rev 1 tables as versioned reference data | Blocker |
| Annex B | The rev03 workbook is the only accepted submission format (4.2.7.1) | Nothing | Populate a copy of the workbook from portal data, preserving its formulas | Blocker for "ready for submission" |
| Annex C | Deemed-to-satisfy schemes (NABERS UK and others) | Nothing | Record a scheme rating as evidence where it satisfies a requirement | Advisory |
| Annex E | PC-on-track predictive checks at practical completion | Nothing | Out of scope for a measured-data portal in the first release | Later |
| Annex F | Landlord-only and tenant-only routes with Delineated Areas | Meter allocation shares | Later phase; needs the sector-areas model first | Later |

### 2.14 Reference data and the two codebases

- `data/reference/` is empty and gitignored, so **nothing factor-based works in any deployment today**. The `nzcbs-standard` skill already carries the Rev 1 tables as ten CSVs in the proforma's layout (subsector columns, commencement-year rows), plus `menus.csv` with every controlled vocabulary the proforma uses. Those files, not a hand transcription, should become the portal's reference data, checked against Annex A once and checksummed.
- The portal and the MCP layer each hold a copy of the NZCBS check. Both are superseded by this plan. The intent is one rule engine with the Standard's own section numbers on every rule, used by the portal, the MCP tools and the skill, so NZC AI and the Portal never disagree on a limit or a date.
- The links supplied for the Standard and the proforma are bare file-host names, so neither file could be fetched from this session. The skill's extracts were used instead. Dropping the official PDF and the rev03 workbook into the deployment's reference folder is part of Phase A.

---

## 3. The target: an NZCBS submission pack

One command per asset and RPEP produces:

1. **The populated proforma.** A copy of the claimant's rev03 workbook with Submission Info, Summary, Operational-Figures, Operational-AUA, Refrigerants and Works-1 to Works-5 filled from portal data, formulas and formatting preserved, dropdown values taken only from the proforma's own menus. Every populated cell maps to a portal value with its provenance row.
2. **The evidence report.** A branded document that walks the submission requirement lists (4.2.7, 5.1.5, 5.2.6, 5.3.4, 5.4.5, 5.5.4, 5.6.5, 5.7.5, 5.8.6, 5.9.5, 5.10.2.4) in order, stating for each item the value, the method statement, the factor used with its DESNZ reference, or that the item is supplied as an attachment, or that it is missing. Missing items are printed as missing. The cover uses the permitted pre-verification phrase and states version, building and works types, sectors, RPEP, ORP dates and limit year.
3. **The evidence bundle.** Half-hourly readings per meter for the ORP, consent records, the occupancy calculation, the demand percentiles with their method, uploaded attachments (schematics, servicing records, the whole life carbon assessment, the Retrofit Plan, constraint drawings), and a manifest with checksums.
4. **An NZCBS readiness result.** The existing readiness pattern (blocker, gap, advisory with a reason) applied to every mandatory item above, so a client sees what is missing months before the RPEP rather than at submission.

What a human still does: the whole life carbon assessment, the Retrofit Plan, the occupancy survey, the drawings, biofuel certification, the constraint evidence for a reduced renewables target, signing the statements, and engaging the verifier.

---

## 4. Design decisions proposed

- **One rule engine, section-numbered.** A pure module (no database, no HTTP) that takes a building profile and measured figures and returns, per aspect, a result of pass, fail, reporting-only or not-assessable with the governing section number and reason. The portal, the MCP tools and the skill all call it. This repeats the pattern already used for CRREM and keeps the rule "no limit, benchmark or value is invented".
- **Reference data in the proforma's own shape.** Load the ten Rev 1 tables and the menus as `data/reference/uk-nzcbs/v1r1/`, keyed by table, subsector, commencement year and unit, with the row and column headers exactly as the proforma prints them. The current long-format CSV loader is retired. Future revisions are new folders, never edits.
- **NZCBS basis alongside GHG Protocol, never instead.** Operational carbon for the Standard includes T&D and both WTT lines. The carbon engine gains those lines and a labelled NZCBS total; SECR and GHG Protocol totals are untouched.
- **Measured figures come from meters; everything else is a declared record with evidence.** Generation, heat, water and bulk fuel become meter or delivery records with the same provenance model as readings. Classification, areas, occupancy, systems registers and works programmes are declared records that carry who declared them and what evidence file supports them. The basis flag already distinguishes measured from client-declared.
- **Proforma population in the Python service.** The MCP layer already ships Python and the workbook work (copy, write cells, preserve formulas, recalculate) is established there. The portal calls it as a tool or a script; the workbook template is supplied per deployment like other reference files, not committed.
- **Claims language enforced in code.** One shared set of strings for every status label and cover statement, with a test that no user-facing string contains "aligned", "compliant with" or "certified" in an NZCBS context.

---

## 5. Build plan, in phases

Each phase is a pull request set that needs Iain's verification before it starts. Sizes are relative, not dates.

### Phase A: reference data and the rule engine (no UI, no schema change)

| Item | What | Size |
|---|---|---|
| A1 | Load the Rev 1 tables and menus from the skill into `data/reference/uk-nzcbs/v1r1/`; new loader; checksum; verify a sample of cells against Annex A by hand and record it | M |
| A2 | Classification: building type (Table 4), works type (Table 5), sector and subsector areas with the 10% and 30% rules (4.2.2), Table 12 reclassification, Additional Uses cap | M |
| A3 | Limit selection: limit year rules per building type and route (5.2.7.1, 5.1.6), Equation 1a and 1b, GIA or NIA basis, region to renewables target with Equation 5, the 15% reuse reduction, the kWp floors | M |
| A4 | Aspect rules 5.2 to 5.10 as pure functions returning the section-numbered result, including Equations 4, 8, 9a to 9c and the demand percentiles | L |
| A5 | Tests built from the Standard's own worked examples and notes (Figure 5, the 5.3 notes, the 5.9 threshold) | M |
| A6 | Retire the two existing NZCBS checks in favour of the engine; MCP tools re-pointed | S |

### Phase B: data model

| Item | What | Size |
|---|---|---|
| B1 | Asset NZCBS profile: GIA, NIA, footprint, region, building type, approach (whole, landlord, tenant), RPEP, route, Table 7 sector fields | M |
| B2 | Sector areas and Additional Use areas per asset, with submeter links | M |
| B3 | Works programmes (up to five): type, commencement and completion dates, imported upfront and life cycle carbon by module, PV kWp and kgCO2e, attachments | M |
| B4 | Meter model extended: generation (total and export), heat, water by source, bulk fuel deliveries and stock | L |
| B5 | Registers: fossil fuel systems with exception category; refrigerant systems with charge, install date and servicing records; district network connection; offsets | M |
| B6 | Occupancy record per asset and ORP (Equation 4 inputs) | S |
| B7 | Evidence attachments (file storage is new to the portal) | M |
| B8 | Submission lifecycle per asset: state, dates, claim period, next RPEP | S |

### Phase C: assessment and readiness

| Item | What | Size |
|---|---|---|
| C1 | Operational energy per the Standard over the ORP: in-scope supplies, exclusions, additional-use split, NZCBS carbon basis with WTT lines, PUE for data centres | L |
| C2 | Full per-aspect assessment on the asset page, with "within limit" and "above limit" labels and the permitted phrase | M |
| C3 | NZCBS readiness family: one check per mandatory submission item, graded by consequence | M |
| C4 | Demand management statistics from stored half-hourly readings | S |

### Phase D: outputs

| Item | What | Size |
|---|---|---|
| D1 | Proforma population from a supplied rev03 workbook, menus-only values, formulas preserved, recalculated | L |
| D2 | Evidence report in the portal's report branding, walking every submission requirement list | L |
| D3 | Evidence bundle with manifest and checksums | S |
| D4 | Claims-language guard and the cover statement | S |

### Phase E: NZC AI

| Item | What | Size |
|---|---|---|
| E1 | MCP tools: classify, limits for a profile, assess an aspect, readiness, generate pack, scoped by the per-client API keys | M |
| E2 | Point the `nzcbs-standard` skill at the same reference files and engine so the assistant and the portal share one rulebook | S |

### Phase F: later

Annex F landlord and tenant routes, district networks (5.7) and space heating limits (5.8) for the sectors that need them, Annex E PC-on-track, Annex C deemed-to-satisfy evidence, offsets (5.10) with the carbon offsetting skill.

**Suggested order.** A, then B1 to B4 and C1 together (that is the first point at which a real building returns a real operational energy result on the Standard's basis), then C2 to C4, then D, then E. B5 to B8 slot in alongside C.

---

## 6. Decisions needed before Phase A

1. **First target population.** Existing Buildings on the whole-building route (the landlord portfolio case) first, New Buildings second? The limit-year and route logic differs and the first choice sets the test data.
2. **The workbook and the PDF.** Confirm where the official rev03 proforma and the Standard PDF will live for each deployment (reference folder, not the repository), and that NZCBS Ltd's terms allow populating a copy for a client submission.
3. **File storage.** Evidence attachments are the first binary files the portal would hold. Local disk, object storage, or links to the client's own document store?
4. **Proforma population in Python.** Agree that the Python service owns workbook writing, or choose a TypeScript route and accept rebuilding the recalculation step.
5. **Labels in the UI now.** The pass and fail labels on the current indicative check could be changed to "within limit" and "above limit" in a small standalone change ahead of the rest, if Iain prefers to remove the claims risk early.

---

## 7. Risks

- **Transcription accuracy.** The limit tables came from the rev03 proforma, not the PDF's Annex A. Phase A1 includes a hand check of sample cells and the tables are versioned and checksummed. A wrong limit is the single most damaging bug this feature could have.
- **The Standard will change.** Rev 1 already renumbered section 5; future versions add life cycle, demand management and water limits and extend space heating. Every rule carries its version and section; a new version is a new reference folder and a new engine version, never an edit.
- **Data that clients do not have.** Most portfolios lack generation metering, NIA, footprint areas, occupancy evidence and system registers. The readiness checks will show long lists at first. That is the product working: the gaps exist whether or not the portal names them.
- **Scope creep into assessment work.** The embodied carbon assessment and the Retrofit Plan are regulated professional outputs. The portal imports, checks and packages them. It does not produce them.
- **Claims.** Any UI text, export or marketing line that implies alignment before verification breaches 7.5 and exposes the business and the client. The guard in D4 and the marketing log rule cover this; until then the current "indicative check" wording stands.

---

## 8. What this means for the marketing log

Nothing in this document is built, so `whats-live.md` does not change. When Phase C lands, the entry will read "UK NZCBS pre-verification assessment and readiness, Coming soon", with the caveat that the portal produces evidence for submission and that verification remains with an approved verifier. The phrase "Net Zero Carbon Aligned" must not appear in any NZC marketing until a named building has been verified, and then only for that building and its claim dates.
