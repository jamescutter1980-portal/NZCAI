# NZC AI — Mapping, Roof Outline & PV Design: audit and plan

**Status:** APPROVED by James on 2026-09-09 ("Go with all assumptions" — every recommendation
in section H taken as decided). Engine increments 1–5, 7 and 8 BUILT on 2026-09-09/10 in
`jamescutter1980-portal/nzc-ai-engine`, branch `claude/nzc-pv-design-audit-plan-eyqdsf`; the
build record is that repo's `docs/101-pv-design-mapping.md`. Increment 6 (the frontend canvas
in `NZC-Portal/calm-prompt-ai`) is NOT built — the repo was unreachable from the build session
(H1). James's own actions remain open: the EA per-tile download URL (H9), three real roofs for
the LiDAR spike (H9), a Bluesky/Getmapping quote (H7).
**Date:** 2026-09-09 (audit and plan); 2026-09-10 (build status).
**Author:** Claude Code session, on branch `claude/nzc-pv-design-audit-plan-eyqdsf` of `jamescutter1980-portal/NZCAI`.

## 0. What was actually audited, and what could not be

| Repo the brief names | What was reachable | Commit audited |
|---|---|---|
| "Engine repo at `C:\nzc-group-ai`" | `jamescutter1980-portal/nzc-ai-engine` (the repo's own docs call it `C:\esg-ai`; `docs/BRIEF_CORRECTIONS.md:19` records that `C:\nzc-group-ai` was a naming slip in earlier briefs). Cloned and read in full where relevant. | `9db155b`, 2026-09-09 |
| "The frontend repo" | `NZC-Portal/calm-prompt-ai` (TanStack Start / React / Leaflet). **Not reachable from this session**: the session's repo attach refused a cross-owner add ("session already has repos from owner jamescutter1980-portal"). Every statement below about the frontend is taken from the engine's own docs and is marked **[frontend: unverified]**. | — |
| `jamescutter1980-portal/NZCAI` (this repo) | `main` is a README only. Branch `claude/nzc-portal-data-roadmap-43gsti` holds a Next.js "NZC Portal" scaffold (n3rgy connector, consents, readings) with no map, PV or microgen code. | `9318389` |
| `jamescutter1980-portal/footprint-Foxsoft-NZC` (Rails NZC Portal) | Cloned and grepped to answer Q10. | `9d2c023`, 2025-06-13 |

Two external pages needed for sections D and E (`environment.data.gov.uk`, `joint-research-centre.ec.europa.eu`) are blocked by this session's egress proxy; those facts come from the engine's licence register (verified 2026-09-06 by the engine team) and from web search results, and are marked where so.

Tests: the engine's mapping, PV design, tile, building and UPRN suites were run here under Python 3.13 (the repo pins 3.14; 3.11 fails to import the gateway on an f-string syntax): **89 passed, 1 skipped** (`test_pvdesign_layout`, `test_mapping`, `test_map_tiles`, `test_building`, `test_pvdesign_golden`, `test_open_data_guard`, `test_pvdesign_engines`, `test_pvdesign_gateway`, `test_uprn`). The skipped test is the opt-in live PVGIS call.

---

## A. Audit findings (Stage 1)

### Mapping and Google

**1. AssetMap component — does it exist? Which providers? Is the switch functional?**

- **No AssetMap component exists in the engine.** The dual-provider component brief (MapLibre default, Google for Solar content) was evaluated and stopped at its own gate: `docs/24-assetmap.md:115-120` — "STOPPED AT THE BRIEF'S OWN GATE … **no code built**". `docs/00-project-map.md:3364-3375` repeats this.
- **The engine's map contract is Leaflet, not MapLibre.** `app/mapping/tiles.py:152-190` `tile_sources()` returns `"provider": "leaflet"` with signed proxy URL templates for a basemap and an imagery layer. There is no MapLibre reference anywhere in `app/` or `tests/`; the only mentions are in the brief record (`docs/24`) and the project map.
- **The Google Maps JS path is stubbed off.** `app/gateway/pvdesign_actions.py:77-98` `act_pvdesign_config` returns `"mapsBrowserKey": ""` unconditionally with the comment "The drawing canvas is Leaflet on OS/OSM + Esri imagery (no Google, James 2026-08-15)". `config.py:509` still defines `GOOGLE_MAPS_BROWSER_KEY` but nothing serves it.
- **There is no provider switch.** `app/mapping/googlegate.py` is a per-SKU call counter and cap, not a map-provider switch (`googlegate.py:37-39, 50-67`). The action `map_get_asset` exposes `google.configured` (`mapping_actions.py:268`), which is a boolean derived from key presence.
- **[frontend: unverified]** Per `docs/54-code-scope-handover.md:205` the frontend uses Leaflet, client-only loaded. Per `docs/00-project-map.md:3216-3218` (2026-08-15) maps were rebuilt "on Leaflet + OS Open Zoomstack + Esri World Imagery through a signed engine tile proxy". The PV drawing canvas is `src/components/app/pv-design-map.tsx` (`docs/pv-design.md:31`); on 2026-08-14 it rendered only when `Boolean(mapsKey) && hasLocation` against Google Maps JS (`docs/PV_MAP_DIAGNOSIS.md:182-193`). **Whether `pv-design-map.tsx` was migrated to Leaflet on 2026-08-15 or still expects a Google key (and therefore never renders, since the engine now always sends `""`) is ambiguous from the engine side.** This must be checked in the frontend repo before any build.

**2. Google Solar API — live calls to buildingInsights or dataLayers? Backend only?**

- **One call site, backend only:** `app/pvdesign/roofdata.py:44-135` `GoogleSolarProvider` calls `https://solar.googleapis.com/v1/buildingInsights:findClosest` (`roofdata.py:53, 78-82`). Reached through `roofdata.provider()` (`roofdata.py:137-139`) from `act_pvdesign_roof_prefill` (`pvdesign_actions.py:277-296`).
- **dataLayers: no call anywhere.** Marked as an extension point only (`roofdata.py:46-47`); deliberately absent from the allowed SKU list (`googlegate.py:37-39`).
- **Gating:** `config.py:558` `SOLAR_API_ENABLED` defaults to `"0"`; the server key `config.py:510` is empty; `.env.example:93-96, 296` says the keys "are retired: leave unset". `app/egress.py:186-194` lists both Google hosts with default "off". `tests/test_open_data_guard.py:31-33, 48-52` pins that they stay off by default.
- **A second Google host exists:** Static Maps for the report drawing basemap, `app/pvdesign/drawing.py:21, 38, 173-194` `fetch_basemap` → `maps.googleapis.com/maps/api/staticmap`. It is keyed on `GOOGLE_MAPS_SERVER_KEY` **alone, not on `SOLAR_API_ENABLED`** (`drawing.py:177-179`).
- **Dev script:** `scripts/solar_spike.py:44` calls the same endpoint from the command line.
- **No Solar key reaches the browser.** `act_pvdesign_config` sends `mapsBrowserKey: ""`; `googlegate.status()` returns only `browserKeyPresent`/`serverKeyPresent` booleans (`googlegate.py:70-79`).

**3. What reads Solar output downstream?**

- `GoogleSolarProvider._parse` (`roofdata.py:112-134`) keeps only per-segment `pitchDegrees`, `azimuthDegrees`, `areaMeters2` and a shading % derived from `sunshineQuantiles`. Google's `yearlyEnergyDcKwh`, `financialAnalyses` and panel counts are discarded. **No Google production or financial figure is read anywhere** (grep over `app/` for those field names: none).
- The segments go to the frontend as `pvdesign_roof_prefill.segments`. **[frontend: unverified]** whether the canvas writes them into planes. The store accepts it: `roof_planes.source` allows `google_solar` (`app/pvdesign/store.py:85`), and `save_planes` writes whatever source string arrives (`store.py:295`).
- Once in `roof_planes`, the values are consumed provider-blind by the layout engine (`layout.py:191, 198`), the performance engine (`performance.py:283-290` in `estimate`), the handover document roof section (`document.py:198-206`), and the concept drawing.
- RFI generation: no reference to Solar or roof segments (`grep -ri solar app/rfi` → none). Report generation outside the PV handover pack: none. Microgen reads the design's **PVGIS** performance result, not Solar (`app/gateway/pv_actions.py:1163-1183` `_mg_design_for`).

**4. Is any Google Maps Content persisted? (constraint 2b)**

Nothing is stored **today**, because both Google keys are unset and `SOLAR_API_ENABLED` defaults off (`docs/00-project-map.md:3216-3218`: "Google key lines removed from .env"). But **two code paths would persist Google content permanently the moment a server key is re-added**, and neither is guarded by a "never store" rule. Flagged as breaches of 2b in the code, dormant in the deployment:

- **(a) Solar-derived roof segments into `roof_planes`.** `store.py:85` documents `source = google_solar` as a legitimate stored value; `save_planes` (`store.py:274-298`) persists pitch/azimuth/`manual_area_m2`/`shading_pct` with that source; issued documents snapshot planes (`pvdesign_actions.py:396-399`). This contradicts the mapping module's own rule ("Google content is NEVER stored here", `app/mapping/store.py:10-11`) — the rule was applied to `mapping.db` but not to `pvdesign.db`.
- **(b) Static Maps satellite PNG into the issued handover pack.** `pvdesign_actions.py:409-413` fetches a Google Static Maps tile at issue time and passes it to `concept_figure`, which draws it as the figure background (`drawing.py:210-213`); the figure is embedded in the `.docx`/`.pdf` written to `EXPORTS_DIR` (`pvdesign_actions.py:437-445`) and retained as an export. That is Google Maps Content stored permanently inside a client document.
- Not breaches: `pvgis_cache` (PVGIS, not Google; `store.py:131-135`); `google_usage` holds counts only (`mapping/store.py:66-71`); the mapping store holds only our geometry.

**5. What aerial/satellite tile source does the map use today? Licence and cost?**

- `app/mapping/tiles.py:193-205 _upstream`: **imagery** = Esri World Imagery via ArcGIS Location Platform (`ibasemaps-api.arcgis.com`, `ESRI_API_KEY`); **basemap** = OS Maps API `Light_3857` (OS OpenData plan, `OS_DATAHUB_KEY`), else OpenStreetMap standard tiles. All proxied through `GET /tiles/{layer}/{z}/{x}/{y}` (`app/api/main.py:2563`) with HMAC-signed, expiring URLs (`tiles.py:125-141`); keys never leave the engine (`test_map_tiles.py:12`). Per-month usage counted under `tiles_basemap` / `tiles_imagery` (`tiles.py:232-236`).
- Keys: both landed and live-verified 2026-08-15 (`docs/00-project-map.md:3216-3218`); `docs/86-background-build-plan-2026-09.md:68` lists OS tiles among live data links.
- Licence and cost as recorded in `docs/24-assetmap.md:171-182, 215-235` and re-checked by web search 2026-09-09: Esri Location Platform **2M basemap tiles/month free, then US$0.15 per 1,000**; revenue-generating apps permitted (Agreement §3.1(c)(1)); attribution mandatory; imagery is view-only "Resultant Output" (no scraping/storing, §3.1(d)(6)); **a user-drawn outline is Customer Content and ours** (§5.1(a)). Resolution over UK industrial estates ~30–60 cm (Maxar Vivid), capture age undocumented per area, typically 1–5+ years outside metros (`docs/24:237-240`). OS OpenData plan: £0, unlimited, OGL, attribution "Contains OS data © Crown copyright and database right <year>" (`tiles.py:116`); native zooms 7–16 only (`tiles.py:168-174`).
- **Inconsistency to note:** `docs/24:193-194` says OSM community tiles are "excluded per the brief — not licensed for production commercial load", yet `tiles.py:204` uses them as the key-less basemap fallback and `docs/opendata/LICENCES.md` lists them as "Display yes". With the OS key present this fallback is never exercised, but it remains in code.

### PV and yield

**6. What model produces kWh today?**

- **Our own engine, from PVGIS.** `app/pvdesign/performance.py:60-90` `pvgis_pvcalc` calls PVGIS v5.2 `PVcalc` per roof plane (lat/lon, kWp, tilt, aspect, losses), cache-first (`store.py:454-470`), gated by `NZCAI_PVGIS_ENABLED` (default on, `config.py:500-503`); `performance.py:137-151` is a built-in UK regional yield table used when PVGIS is unavailable, with the source recorded on every result. `estimate()` (`performance.py:265-318`) sums per-plane yield with a stated shading derate. Golden test: 237 kWp Midlands fixture within ±5% of the 916 kWh/kWp anchor (`tests/test_pvdesign_golden.py:22`).
- Self-consumption, carbon and the 25-year investment case run through our own code (`performance.py`, `investment.py` reusing `microgen.engine`). The microgen "performance vs expectation" report uses the design's PVGIS P50 as the expectation when no business case is entered (`app/microgen/performance.py:139-145`, `pv_actions.py:1163-1183`).
- **Google production/financial figures are used nowhere** (see Q3). Constraint 2c holds.

**7. Is PVGIS referenced?** Yes: `config.py:496-503`, `performance.py` throughout, `app/datalinks.py:112-121, 252-256` (probe + data-link row), `egress.py:183-185`, `docs/opendata/LICENCES.md` (row "PVGIS … Free re-use with attribution"), fixture `tests/fixtures/pvdesign/pvgis_pvcalc_237kwp_midlands.json`. The endpoint is pinned to `api/v5_2` (`config.py:500-501`). PVGIS 5.3 (SARAH-3, ERA5 to 2023) is published at `api/v5_3` (web search, JRC release page; page itself unreachable from here) — see H.

**8. Any LiDAR / DSM / raster elevation handling?**

- **Point reads only, no rasters.** `app/building/evidence.py:48-50, 298-330` reads the EA 1 m composite DTM and last-return DSM at a single point by WMS `GetFeatureInfo`; `height_at` (`evidence.py:336-363`) returns roof-minus-ground with caveats (England only; mosaic of survey dates; point not maximum). Gated by `NZCAI_LIDAR_ENABLED` default off (`config.py:857`), recorded append-only in `building_reads` (`app/building/store.py:17-36`). Live-verified 2026-09-06 (`docs/95-uprn-spine.md` §5).
- No GeoTIFF download, no tile cache, no slope/aspect, no plane fitting. `requirements.txt` has no rasterio/GDAL/numpy-geo dependency; `grep -ri 'rasterio|geotiff'` over `app/` → none.
- A 45 m-box OS Open Zoomstack footprint read exists alongside it (`evidence.py:46-47, 270-293`) and saves the polygon as the site footprint with source `os_zoomstack` unless a person drew one (`app/building/service.py:44-54`).

**9. Does a module library exist?**

- **No.** One hard-coded module: `app/pvdesign/layout.py:38-39` `DEFAULT_MODULE = {wp 580, 2.28 m × 1.13 m}`. `auto_layout` accepts a `module` argument (`layout.py:160`) but `service.run_auto_layout` never passes one (`service.py:65`). `layouts.module_wp` is stored (`store.py:97`) but always 580. `act_pvdesign_config` exposes `moduleDefault` only (`pvdesign_actions.py:91`).
- Orientation is fixed per mounting (portrait for flush, landscape pairs for flat E-W: `layout.py:141-157`), not user-selectable. Fixing type is derived from roof type (`MOUNTING_FOR_ROOF`, `layout.py:31-36`), not chosen per plane. Row pitch, walkway spacing, setback (1 m) and E-W tilt (10°) are module constants (`layout.py:46-58`). There is no inter-row shading check and no ground-coverage-ratio output (only `densityKwpM2`, `layout.py:255`).

### Microgen and shared model

**10. Does the microgen app exist in NZC AI, or only in NZC Portal?**

- **It exists in NZC AI (the engine), substantially.** `app/microgen/` — 25 modules, ~11,000 lines: `store.py` (2,533; schema `store.py:39-590`), `service.py`, `engine.py`, `ingest.py`, `assets.py`, `allocation.py`, `allocation_report.py`, `basis.py`, `carbon.py`, `compliance.py`, `events.py`, `gateway_sim.py`, `market.py`, `metrics.py`, `performance.py`, `performance_report.py`, `rates.py`, `registers.py`, `rollup.py`, `settlement.py`, `statement.py`, `supplier_flow.py`, `topology.py`, `validation.py`, `waterfill.py`, `sources/__init__.py`. Gateway actions in `app/gateway/pv_actions.py`; PV design in `app/pvdesign/` (11 modules) with `app/gateway/pvdesign_actions.py`. Build records: `docs/micro-generation.md`, `docs/91`, `docs/92`, `docs/93`, `docs/pv-design.md`. 25 test files `tests/test_microgen_*.py` plus the golden workbook fixture.
- **[frontend: unverified]** eight Micro-Gen tabs including PV Design (`docs/93-metering-spec-adoption.md:1177-1190`, `docs/54:207`).
- **NZC Portal (Rails, `footprint-Foxsoft-NZC`):** only a `units.microgeneration_pv` float column (`db/schema.rb:142`) displayed as a card value (`app/views/units/_epc_details_column.erb:42-43`, summed in `app/models/site_summary.rb:64-72`). No billing, no meter data, no map. `docs/91:6-9` mentions a Lovable prototype "NZC solar app" and a "smaller microgeneration section" on the Portal's Vercel deployment; neither is in any repo reachable here. `docs/00-project-map.md:3205-3222` records the standing rule that the Portal repo is off-limits.

**11. Does microgen have map or geometry capability?**

- **No geometry of its own.** `pv_sites` has no coordinates (`store.py:39-71`). For weather normalisation it borrows a location: the mapping store's `asset_locations` row for `gateway_site_id`, else the linked design project's lat/lng (`pv_actions.py:1187-1204` `_mg_location`). The only orientation data is typed text: `pv_strings.orientation TEXT` and `pv_strings.tilt_deg` (`store.py:210-221`), and `pv_plants.mounting TEXT` (`store.py:186`). `docs/93:82-83`: "no buildings tier". It is meter-data driven.

**12. Is there a shared site/asset model that both microgen and the map read from? (KEY QUESTION)**

**Shared key, separate representations.** Precisely:

- The one shared identity is the gateway **Site record**: an in-memory dict persisted to `client-data/state/gateway.json` (`app/gateway/actions.py:338-340` `_PERSISTED`), created by `act_create_site` (`actions.py:1163-1188`), fields `assetName, assetAddress, fundManager, assetManager, assetValue, tenantName, passingRent, leaseExpiry, rentReview, floorAreaM2` (`actions.py:1121-1123`). **It holds no coordinates, no UPRN and no geometry.**
- Every module keys on that Site id but keeps its own representation of the building in its own SQLite file:

| Representation | Store | Key column | Link strength |
|---|---|---|---|
| Location (lat/lng, postcode, UPRN, source, approximate) | `mapping.db` `asset_locations` (`app/mapping/store.py:25-37`) | `site_id` = Site id | 1:1, required |
| Building footprint (multi-part, versioned, source `user_drawn/imported/os_zoomstack`) | `mapping.db` `footprints` (`store.py:38-48`) | `site_id` | 1:n history |
| Roof planes (polygon, pitch, azimuth, exclusions, shading, source) | `pvdesign.db` `roof_planes` (`app/pvdesign/store.py:75-91`) | `project_id` → `design_projects.gateway_site_id` **nullable** (`store.py:41`) | **optional** — a project created from the PV Design tab without `gatewaySiteId` has no site |
| Module layout (grid, kWp, module count) | `pvdesign.db` `layouts` per project revision (`store.py:92-102`) | via project | same |
| Billing PV site (kWp, rates, MPANs) | `microgen.db` `pv_sites` (`app/microgen/store.py:39-71`) | `gateway_site_id` **NOT NULL** (`store.py:42`) | required |
| Plants / inverters / strings (kWp, panel count/Wp, mounting, orientation text, tilt) | `microgen.db` `pv_plants`, `pv_inverters`, `pv_strings` (`store.py:177-221`) | via `pv_site_id` | typed by consultant |
| Grid connections, devices, measurement points | `microgen.db` (`store.py:228-320`) | `gateway_site_id` | required |
| Building height / OS footprint read | `building.db` `building_reads` (`app/building/store.py:17-36`) | `site_id` | append-only |
| UPRN match | `uprn.db` `site_matches` (`app/uprn/store.py:42-54`) | `site_id` | append-only |

- The links between representations are **copies, not references**: the map→PV bridge copies footprint parts into new roof planes (`mapping_actions.py:333-343`), after which map footprint and roof planes diverge independently; handover copies `total_kwp` into `pv_sites.pv_capacity_kwp` and rates/MPAN (`app/pvdesign/service.py:179-194` `handover_fields`) and the default plant inherits that kWp (`microgen/store.py:774-806`); the link back is `design_projects.handover_pv_site_id` (`store.py:55`). Tilt, azimuth, module count, module Wp and plane geometry are **not** carried across at handover.
- The engine team's own spec adoption table names the gap: `docs/93-metering-spec-adoption.md:86` — spec §3.2 `pv_arrays` (tilt, azimuth, module count/Wp, γ, shading) vs today's `pv_strings` → "EXTEND/rename", not yet built.

So: **one shared Site key; no shared building geometry; PV design geometry is only optionally attached to the Site; microgen never sees geometry.**

**13. Is there a stored array definition microgen billing could reconcile against, or only meter readings?**

- **Partial, and not where billing looks.** What exists: (a) the design project's locked `layouts` row and `roof_planes` (module Wp, module count, kWp per plane, pitch, azimuth) — revision-locked, but reachable from a billing site only through `handover_pv_site_id`, one-way, set once; (b) `pv_plants.capacity_kwp / panel_count / panel_wp / mounting` and `pv_strings.module_count / capacity_kwp / orientation / tilt_deg` — hand-typed configuration, not populated by handover (`handover_fields` passes site-level fields only); (c) `pv_business_cases` (expected annual/monthly kWh, source required) and the design's PVGIS monthly P50 as fallback expectation (`microgen/performance.py:139-145`).
- What billing reconciles against today: **meter readings only**, plus a capacity **check** (`assets.capacity_reconciliation`, `assets.py:220-229`: plant kWp roll-up vs `pv_sites.pv_capacity_kwp`, reports a mismatch and corrects nothing). The performance report reconciles actual generation vs the design P50 kWh (`pv_actions.py:1206-1240`), which is a yield reconciliation, not a geometry one.
- Therefore: no single, site-owned array definition (kWp, module count, tilt, azimuth) exists that both design and billing read.

---

## B. Data model

Principle: **extend, do not replace.** The gateway Site id is already the spine every store keys on. The change is to give building/roof geometry a single home keyed on the Site, and to give the array definition a home in the microgen store where billing and performance already look.

### B.1 Roof plane (site-owned, in `mapping.db`)

Move the roof-plane concept from "belongs to a design project" to "belongs to the Site", next to the footprint it is drawn from. A design project then *references* planes rather than owning copies.

```
roof_planes
  id                TEXT PK
  site_id           TEXT NOT NULL          -- gateway Site id (as footprints.site_id)
  company_id        TEXT NOT NULL
  footprint_id      TEXT                   -- the footprint version it was drawn over (provenance)
  name              TEXT
  polygon           TEXT NOT NULL          -- [[lat,lng],...] WGS84, ours
  roof_type         TEXT NOT NULL          -- trapezoidal | standing_seam | flat_membrane | fragile_asbestos (existing vocabulary)
  pitch_deg         TEXT NOT NULL
  azimuth_deg       TEXT NOT NULL          -- compass, 180 = S (existing convention)
  geometry_source   TEXT NOT NULL          -- user_drawn | os_zoomstack_split | imported
  pitch_source      TEXT NOT NULL          -- manual | lidar_dsm | roof_type_default
  azimuth_source    TEXT NOT NULL          -- manual | lidar_dsm | longest_edge
  lidar_fit         TEXT DEFAULT '{}'      -- JSON: cells, rms_m, inlier_frac, composite_version, bbox_27700 (only when pitch/azimuth_source = lidar_dsm)
  imagery_date      TEXT DEFAULT ''        -- capture date if drawn over imagery and known; same rule as condition_items.basis
  shading_pct       TEXT DEFAULT '0'
  is_current        INTEGER DEFAULT 1      -- versioned like footprints; edits insert a new row
  captured_by, captured_at
```

Relation: `footprints` 1→n `roof_planes` (a footprint part typically becomes one or more planes; the multi-part bridge in `mapping_actions.py:333-343` becomes "create one plane per part, referencing the footprint id" instead of a copy into `pvdesign.db`).

### B.2 Exclusion zone (per plane, in `mapping.db`)

```
roof_exclusions
  id, roof_plane_id, company_id
  kind         TEXT NOT NULL   -- setback | walkway | fire_break | rooflight | plant | vent | custom
  shape        TEXT NOT NULL   -- polygon | strip | offset
  geometry     TEXT NOT NULL   -- polygon: [[lat,lng],...]; strip: {a:[lat,lng], b:[lat,lng], width_m}; offset: {width_m} (perimeter setback)
  basis        TEXT NOT NULL   -- imagery | site_verified | rule (rule = generated from a parameter, e.g. 1 m setback)
  imagery_date TEXT DEFAULT ''
  note, captured_by, captured_at
```

Today's `roof_planes.exclusions` JSON (`pvdesign/store.py:83`) becomes rows of kind `custom`/`plant`; the hard-coded 1 m perimeter (`layout.py:46`) and walkways (`layout.py:51-52, 57`) become `offset`/`strip` rows generated by rule and editable. This is what makes "gross vs net area" and "area utilisation" explainable line by line.

### B.3 Module library (global + per-company, in `pvdesign.db`, same pattern as `rate_cards`)

```
modules
  id, company_id NULL=global, code, manufacturer, model
  wp INTEGER, length_m, width_m, thickness_mm, weight_kg
  efficiency_pct, temp_coeff_pmax (γ, default -0.0035 — the spec's field, docs/92:290)
  bifacial INTEGER, technology TEXT (topcon|perc|hjt), datasheet_file_id
  effective_from, is_active, created_at, updated_at
```

Seeded with the current default (580 Wp, 2.28 × 1.13) so every existing layout re-runs identically. Mounting/fixing catalogue stays as data on the same footing:

```
fixings
  id, code, label, roof_types TEXT (JSON list), orientation TEXT (portrait|landscape|either),
  default_tilt_deg, min_row_gap_m, walkway_every_n_rows, walkway_m, default_setback_m,
  ballast_kg_m2 (flat), pricing_item_code (joins the rate card's mounting line)
```

### B.4 Layout parameters (per design project revision, in `pvdesign.db`)

Add to `layouts` (or a sibling `layout_params`) what is currently a constant: `module_id`, per-plane `fixing_id`, `orientation`, `tilt_deg` (ballasted arrays), `row_pitch_m`, `ground_coverage_ratio`, `inter_row_shading` (computed: winter-solstice 10:00–14:00 shadow length vs row pitch, pass/fail with the angle used), `setback_m`, `walkway_m`. The grid payload stays as it is (deterministic cell keys, deletions survive recompute — `layout.py:160-165`).

### B.5 Array definition (site-owned, in `microgen.db` — the spec's `pv_arrays` slot)

Fills the "EXTEND/rename" row at `docs/93:86`. Written at handover, one row per roof plane, under the plant:

```
pv_arrays
  id, pv_plant_id NOT NULL, gateway_site_id NOT NULL, company_id NOT NULL
  roof_plane_id            TEXT       -- reference into mapping.db (nullable for legacy typed arrays)
  design_project_id, design_revision  -- provenance: which locked revision produced it
  name
  tilt_deg, azimuth_deg NOT NULL      -- 180 = S
  module_id, module_wp, module_count NOT NULL, capacity_kwp NOT NULL
  orientation (portrait|landscape), fixing_id, row_pitch_m, gcr
  shading_factor                      -- annual, from the design (spec field)
  expected_annual_kwh, expected_monthly_kwh JSON   -- the plane's PVGIS P50, source label kept
  status TEXT (designed | as_built | retired), superseded_by_id
  created_at
```

`pv_strings` stays as electrical grouping (inverter → strings) and gains `pv_array_id`; `pv_plants.capacity_kwp` becomes the roll-up of arrays with the existing reconciliation **check** semantics (never a correction — the rule at `docs/micro-generation.md:76-80` stands). `pv_sites.pv_capacity_kwp` continues to bill.

### B.6 Does this extend the shared model or need a new one?

**Extends.** No new "asset model" is needed: the Site id already threads every store. Two changes make the shared model real rather than nominal:

1. `design_projects.gateway_site_id` becomes **required** for any project that has drawn geometry (a project may still be created address-first, but it cannot hold planes until it is attached to a Site). Decision for James: see H.
2. Roof geometry moves to `mapping.db` keyed on Site; `pvdesign.db` keeps design state (consumption, layout, results, documents) and references planes by id; `microgen.db` gains `pv_arrays`. Issued documents already snapshot planes (`pvdesign_actions.py:396-399`), so site-owned planes do not weaken revision locking.

Migration: existing `pvdesign.roof_planes` rows copy to `mapping.roof_planes` with `site_id` from the project (or a placeholder site created from the project's name/address for unattached projects — flagged for the consultant), `geometry_source` preserved, `pitch_source = manual`. Rows with `source = google_solar` are migrated with `pitch_source = 'legacy_google_solar'` and surfaced for the consultant to re-confirm or re-derive; none exist on the live box today (keys were never on long enough), which should be confirmed by a one-line count before migration.

---

## C. Google removal assessment

**What breaks if Solar API is dropped: nothing at runtime.** It is off by default, unkeyed, and every caller degrades to manual mode by design (`roofdata.py:72-75, 137-139`; `pvdesign_actions.py:277-296` reports `noCoverage`/`error` honestly). The spike that was to decide its value never completed (`docs/SOLAR_API_SPIKE.md:248-251`: waiting on three addresses) and the one data point snapped to the wrong building (`docs/SOLAR_API_SPIKE.md:260-273`).

**Genuinely Google-specific (delete):**

| Code | What |
|---|---|
| `app/pvdesign/roofdata.py:44-135, 137-139` | `GoogleSolarProvider` and the `provider()` preference for it. Keep `RoofDataProvider`/`ManualProvider` (`roofdata.py:20-42`) as the seam a LiDAR provider plugs into. |
| `app/pvdesign/drawing.py:21, 38, 160-194` | `_STATIC_MAPS`, `fetch_basemap`. `concept_figure` (`drawing.py:197-270`) is provider-agnostic and stays. |
| `app/gateway/pvdesign_actions.py:409-412` | the `fetch_basemap` call at issue. |
| `app/mapping/googlegate.py` (whole file) | SKU gate. The generic monthly counter it wraps (`mapping/store.py:262-278` `count_google_call`/`google_usage` and table `google_usage`) is reused by the tile proxy (`tiles.py:234`) — **rename** to a neutral `usage` counter rather than delete. |
| `app/config.py:509-510, 557-558` | `GOOGLE_MAPS_*_KEY`, `GOOGLE_MONTHLY_CAP`, `SOLAR_API_ENABLED`. |
| `app/egress.py:186-194`; `tests/test_egress.py:61`; `tests/test_open_data_guard.py:31, 76-77, 90` | egress rows and guard entries. |
| `app/gateway/mapping_actions.py:23, 268, 345-352`; `test_mapping.py:260` | `googlegate` import, `google.configured` field, `map_usage` admin action, the gate test. |
| `tests/test_pvdesign_engines.py:321-332` | Solar provider tests. |
| `scripts/solar_spike.py`; `.env.example:93-96, 296`; `docs/SOLAR_API_SPIKE.md`, `docs/PV_MAP_DIAGNOSIS.md`, Google sections of `docs/23`, `docs/24`, `docs/pv-design.md:118-128, 159-161` | Script, config lines, docs (docs to be marked superseded, not deleted). |
| `app/pvdesign/store.py:85` | the `google_solar` source comment; add a CHECK/validation refusing that source on write. |

**Provider-agnostic (keep unchanged):** `app/pvdesign/layout.py`, `performance.py`, `pricing.py`, `investment.py`, `consumption.py`, `document.py`, `service.py`, `store.py` (bar the source vocabulary), `app/mapping/geometry.py`, `store.py`, `geocode.py`, `tiles.py`, the whole of `app/microgen`, `app/building`, `app/uprn`. **[frontend: unverified]** `pv-design-map.tsx` and any Google Maps JS loader in the frontend must be inspected; if it still loads `maps.googleapis.com/maps/api/js`, that is a third Google call site outside the engine's egress inventory.

**Is a MapLibre/Google provider switch still necessary? — No.** Justification:

1. Google's Maps Platform ToS §3.2.3(e) forbids using Google Maps "with or near a non-Google map" in the same application, and §3.2.3(c) forbids tracing building outlines from the satellite basemap (`docs/24-assetmap.md:243-253`). A dual-provider component is therefore either non-compliant or forces the whole app onto Google — which constraint 2a rules out.
2. The only capability that needed Google was Solar roof-segment prefill; LiDAR-derived pitch/azimuth (section E) covers England from open data, and user entry covers the rest, which is exactly the fallback the designer already ships.
3. Aerial imagery and yield both have non-Google sources already wired and live (Q5, Q6).
4. A single Leaflet (or MapLibre) canvas over Esri imagery is the arrangement under which drawn outlines are unambiguously ours (`docs/24:228-233`).

Whether the canvas should be **Leaflet** (what is built) or **MapLibre** (what the brief and constraint 2a name) is a separate frontend choice: both render our GeoJSON over the same signed `/tiles` templates; MapLibre gives vector OS Zoomstack tiles and GPU rendering, Leaflet is already integrated and tested. Recommendation: keep Leaflet for v1 unless the frontend audit shows the drawing tooling is missing anyway, in which case choose MapLibre + `maplibre-gl-draw`/Terra Draw once. Decision in H.

---

## D. Aerial imagery options (UK commercial use)

Honest headline: **there is no open-data (OGL) aerial photograph of Great Britain at drawing resolution.** The free option that exists is a *free-of-charge commercial tier*, not open data, and it is the one already wired. This is the weak point the brief predicted.

| Source | Resolution / age over UK sheds | Licence for a commercial SaaS | Cost | Draw on it? | Store it (reports)? | Notes |
|---|---|---|---|---|---|---|
| **Esri World Imagery (ArcGIS Location Platform)** — wired, keyed, live | Maxar Vivid ~30–60 cm; age undocumented, 1–5+ yrs outside metros (`docs/24:237-240`) | Permitted for revenue-generating apps; attribution mandatory (`docs/24:228-233`) | 2M tiles/month free, then $0.15/1k (location.arcgis.com/pricing, checked 2026-09-09) | Yes — drawn outlines are Customer Content | **No** — imagery is view-only Resultant Output; embedding a stitched tile in a client PDF is not cleared | Capture-date layer exists on Esri's side but is not proxied; needs adding so `imagery_date` can be recorded per plane. Per-licensor (Maxar/Vexcel) flow-down terms still unverified (`docs/24:234-235`). |
| MapTiler Cloud Satellite | Good in cities; Sentinel-2-derived (10 m) elsewhere (`docs/24:183-187`) | Commercial OK on paid plans | Flex ~$29–30/mo, 25k sessions | Yes | No (standard tile terms) | Inadequate over industrial estates; fallback only. |
| Mapbox Satellite | Maxar/Vexcel, similar to Esri | Commercial OK; **tracing/derivative-data terms must be checked** — not verified here | Free tier 50k loads/mo then PAYG; satellite may be premium | Unverified | No | Enquiry item; no advantage over Esri if terms are equal. |
| **Bluesky / Getmapping UK aerial (12.5–25 cm, dated captures, ~3-yr refresh)** | Best available; capture dates known | APGB agreement is **public sector only**; commercial via Bluesky/viaEuropa WMTS under contract | **Not published**; enquiry (web search 2026-09-09 found no price list) | Yes, under contract | Typically yes with a data licence (to confirm) | The only source that is genuinely rooflight/vent-grade and dated. Worth a quote if the assessor workflow needs it; probably £k/yr. |
| OS Data Hub | No aerial layer on any plan I can find in the engine docs; OS Aerial is not an API product | — | — | — | — | Fact to confirm with OS when the Premium question (MasterMap footprints, `docs/24:207-226`) is raised. |
| Google Maps/Static Maps | High res | Tracing forbidden; not near non-Google maps | Billed | **No** | **No** | Excluded by constraint 2a and by terms. |
| Open data alternatives for *geometry* (not photographs): **OS Open Zoomstack local buildings** (OGL) + **EA LiDAR DSM hillshade/slope** (OGL) | Zoomstack generalised (1:10k, not measurement-grade, `docs/24:207-213`); LiDAR 1 m shows ridges, parapets, plant and rooflight boxes as relief | OGL v3 — commercial use permitted, storable, printable | £0 | Yes — a hillshade rendered from the DSM is a legitimate drawing aid and shows roof *structure* better than a 3-year-old photo | **Yes** — the only layer that can lawfully sit under the report drawing | Not a photograph: no colour, no condition. Recommended as the **export/report canvas** and as an overlay in the editor; Esri stays the *viewing* canvas. |

Recommendation for v1: keep Esri World Imagery as the on-screen drawing canvas (already live, free at our volume, outlines are ours); add the Esri capture-date read so every plane carries `imagery_date`; render all exported drawings on OGL layers only (our footprint/planes/modules over OS Zoomstack and, where available, a LiDAR hillshade), never on Esri imagery; obtain a Bluesky/Getmapping quote as a decision item for assessor-grade imagery. Decisions in H.

---

## E. LiDAR pipeline: 1 m DSM → per-plane pitch and azimuth

**Source.** Environment Agency National LiDAR Programme composites, 1 m: DTM, last-return DSM (what the engine reads today, `evidence.py:49-50`) and **first-return DSM** ("FZ DSM", better at building edges — data.gov.uk dataset text via web search). OGL v3 (`docs/opendata/LICENCES.md` row "LIDAR Composite DTM / DSM 1 m"). England, 302 survey blocks flown Jan 2017–Feb 2023; distributed as GeoTIFF in 5 km OS National Grid tiles from the DEFRA Survey Data Download service, and as WMS on the Data Services Platform. Because it is OGL the tiles **may be cached on the engine permanently** — unlike imagery.

**Pipeline (all deterministic Python, in a new `app/roofgeom/` beside `app/building/`):**

1. **Tile acquisition.** From the plane polygon's bounding box in EPSG:27700, list the 5 km tile ids; fetch each once (behind the existing `NZCAI_LIDAR_ENABLED` flag; the download is the only egress and carries no client data, same argument as the UPRN edition) and cache under `state/lidar/<composite_version>/<tile>.tif`. Assumption to verify: the survey download service exposes a stable per-tile URL pattern usable without a browser session; if not, a WCS `GetCoverage` on the DSP, or an admin-driven manual tile drop (as the UPRN zip allows, `docs/95` §2) is the fallback. Page unreachable from this session.
2. **Coordinate transform.** Planes are stored WGS84 lat/lng. Transform to EPSG:27700 for cell lookup. The stdlib has no OSTN15; a 7-parameter Helmert gives ~2–5 m absolute error, which is fine for *sampling inside a polygon eroded by 1.5 m* but is not fine for reporting coordinates. Recommendation: add `pyproj` (BSD) as a dependency for a correct OSTN15 transform; flagged in H because the engine has so far been deliberately stdlib-heavy.
3. **Sampling.** Erode the polygon by 1.5 m (edge cells mix roof and ground); read DSM cells inside; subtract nothing (pitch/azimuth need surface height only; DTM is used for the "is this a roof at all" test: median DSM − median DTM < 2 m → refuse, reuse `NOT_A_ROOF_M`, `evidence.py:53`).
4. **Plane fit.** Least-squares `z = ax + by + c` with RANSAC (inlier tolerance 0.25 m) to reject rooflights, plant, parapets and no-data (−9999 sentinel, `evidence.py:330`). Pitch = `atan(hypot(a, b))`; aspect = `atan2(-a, -b)` (direction of fall), converted to compass so that 180 = south, matching the store convention (`pvdesign/store.py:81`).
5. **Quality gates.** Minimum 40 inlier cells; inlier fraction ≥ 0.6; RMS residual ≤ 0.3 m; pitch ≤ 60°. Failing any gate returns "undetermined" with the reason, never a number (the building module's rule 4, `evidence.py:30-31`).
6. **Duo-pitch detection.** If the residual is high and the inliers split into two aspect clusters ~180° apart, report "this polygon spans a ridge — split it" with the suggested ridge line (the intersection of the two fitted planes projected to plan). The consultant splits; the engine does not redraw.
7. **Low-pitch sheds.** At 4–8° the aspect from a 1 m DSM is noisy but usable over a large roof (thousands of cells); over small planes the azimuth gate may fail while pitch passes — then report pitch from LiDAR and azimuth from the longest-edge rule (step 8), each with its own source.
8. **Fallback chain, in order,** each recorded in `pitch_source`/`azimuth_source`: `lidar_dsm` → (azimuth) `longest_edge` (perpendicular to the plane's longest edge, with the consultant choosing which side falls) → (pitch) `roof_type_default` (trapezoidal/standing seam 6°, flat membrane 0° with the fixing's tilt, matching `store.py:80`) → `manual`. Manual always wins once entered.
9. **Provenance.** Record composite version, tile ids, cell count, RMS and the mosaic caveat (`evidence.py:89-91`). The composite carries no per-cell survey date; the EA survey index does — a later increment can join it for a "surveyed <year>" line.
10. **Shading (v2, noted only).** A horizon profile from the same DSM per plane is straightforward once tiles are cached; not in v1 — the per-plane shading % stays a stated estimate.

**Coverage limits and staleness.**

- England only from this source. Wales: Natural Resources Wales LiDAR (OGL, DataMapWales) — same pipeline, different tile service; Scotland: Scottish Remote Sensing Portal phases 1–6 (OGL, partial coverage, mostly urban/flood-prone); Northern Ireland: no open LiDAR. The engine already refuses non-English points by nation (`evidence.py:333-343`); extend the same refusal with the reason, then add NRW as the second source.
- Survey dates 2017–2023: a shed built or re-roofed after its block was flown reads as ground (height < 2 m → "not a roof") or as the old roof. The gate in step 3 catches the first; the second is undetectable from LiDAR alone — the plane shows the imagery date beside the LiDAR result so the assessor sees a mismatch.
- 1 m posting cannot resolve individual rooflights reliably (they read as ±0.3 m bumps); they remain drawn exclusions from imagery or a site visit.

**Alternative without raster handling (spike only):** a 5 m grid of the existing WMS `GetFeatureInfo` reads (`evidence.py:301-330`) over a plane — ~80 requests for a 2,000 m² roof. The DSP gateway throttles bursts with 403s (`evidence.py:307-320`), so this is acceptable for a one-off proof on three real roofs, not for production.

---

## F. Build order (smallest useful slice first, ranked by what it unblocks)

Each increment is independently shippable and testable; engine increments do not depend on the frontend repo being reachable, but the v1 user experience does (increment 6).

| # | Increment | Unblocks | Size | Ships with |
|---|---|---|---|---|
| **1** | **Google removal and provider seam.** Delete the code in section C; add a write-time refusal of `source = google_solar`; rename the usage counter; keep `RoofDataProvider` + `ManualProvider`; update egress, guard tests, docs. | Closes the two 2b breach paths; removes the "is Google still needed" ambiguity for everything after. | Small (½ day) | Tests: guard tests updated, `test_pvdesign_engines` Solar cases replaced by a "no provider but manual" case; the concept drawing renders with no basemap. |
| **2** | **Site-owned roof geometry (B.1, B.2) and the reference bridge.** New tables in `mapping.db`; `map_*` actions for plane and exclusion CRUD (versioned, provenance, server-computed areas via `geometry.py`); `design_projects` references plane ids; `map_pv_design` creates references, not copies; migration of existing `pvdesign.roof_planes`; `gateway_site_id` required for planes. | Everything downstream: layout, array definition, LiDAR all key on these rows. Also gives the client-hub map the roof outline without a design project. | Medium (2–3 days) | Hand-calculated area tests for planes and each exclusion shape; provenance tests (edit re-flags); migration test on a fixture db; gateway scoping tests. |
| **3** | **Module and fixing library + layout parameters (B.3, B.4) in the layout engine.** Module selectable per project; fixing per plane; portrait/landscape; setback, walkway, fire-break and row pitch as parameters generating rule-based exclusions; GCR and inter-row shading check for ballasted arrays; gross/net/utilisation outputs; areas per exclusion kind. | The v1 outputs (kWp, count, gross vs net, utilisation) and the report table. Pricing's mounting line joins the fixing catalogue. | Medium (2–3 days) | Known-answer packing tests per fixing; density-band tests retained; a shading-check test at a fixed latitude/date with a hand-computed shadow length; determinism test (same inputs → identical cell keys). |
| **4** | **Array definition into microgen (B.5) at handover, and read-through.** `pv_arrays` table; `handover_fields` extended; plant kWp roll-up check unchanged; performance report shows per-array P50 and geometry; `microgen_asset_tree` lists arrays. | The stated secondary objective: predicted vs actual reconciliation has a persisted design basis in the app that bills. | Small–medium (1–2 days) | Golden: a designed project handed over produces arrays whose kWp sums to the site kWp; capacity reconciliation still reports, never corrects; a typed legacy plant with no arrays is unaffected. |
| **5** | **Report drawing on OGL layers only.** `concept_figure` background = our footprint + OS Zoomstack context (already OGL) and, when cached, a LiDAR hillshade; branded PNG/SVG export action for the report; scale bar and north arrow retained. | Constraint 2a/2b-clean report output; needed before any assessor-facing pack. | Small (1 day) | Snapshot (golden image) test of the figure for a fixture project; no network in tests. |
| **6** | **Frontend canvas (calm-prompt-ai) [not auditable here].** Draw/edit/delete planes and exclusions on Leaflet (or MapLibre — decision) over the signed `/tiles` imagery; per-plane property panel; module/fixing pickers; run auto-layout; delete cells; show LiDAR result and its source badges; show imagery date. | The user-facing v1. | Medium–large (3–5 days, unknown until the repo is read) | `bun test` display-rule tests for source badges and refusals; E2E on the hermetic pair (`docs/54` §11). |
| **7** | **LiDAR pitch/azimuth derivation (E).** `app/roofgeom/`: tile cache, transform, sampling, RANSAC fit, gates, fallback chain, provenance; `map_derive_plane_geometry` action; NRW source second. | Removes the last thing Solar was for; England coverage. | Medium (3 days) + a spike on three real roofs first | Deterministic unit tests on synthetic DSM arrays (flat, 6° south, 30° duo-pitch with a ridge, rooflight bumps, no-data holes); a golden on one real cached tile (OGL, so the fixture can live in the repo); coverage refusal tests. |
| **8** | **LiDAR hillshade/slope drawing aid** rendered as an OGL overlay tile layer from cached tiles. | Better edge/ridge tracing without paying for imagery; report canvas quality. | Small–medium | Golden image test. |

Increments 1–5 and 7–8 are engine-only. If the frontend cannot be read soon, increments 1–5 still deliver a testable API and report path, and the existing PV Design screen keeps working through the unchanged action names (`pvdesign_save_planes` would proxy to the new plane store during the transition).

v2 items are noted, not designed: structural loading (needs `fixings.ballast_kg_m2` and a plane's area — data is captured in B.3 so nothing blocks it), string/inverter allocation (`pv_strings.pv_array_id` reserved), G99/DNO export capacity (`grid_connections.export_limit_kw` already exists, `microgen/store.py:236`), self-consumption netting against half-hourly demand (the design's overlay method exists; the billing-side netting is a microgen allocation matter).

---

## G. Test strategy

**Deterministic unit tests (pure functions, no I/O) —** the engine's standing regime:

- Geometry: area/perimeter/erosion/offset for every exclusion shape, hand-calculated; polygon split by ridge line; longest-edge azimuth; degenerate inputs refuse with plain messages (extends `tests/test_mapping.py:51-69`).
- Layout: packing per fixing/orientation/row pitch; GCR; inter-row shadow length at fixed latitude/date; utilisation arithmetic; cell-key determinism and deletion survival (extends `tests/test_pvdesign_layout.py`).
- LiDAR fit: synthetic 1 m grids with known slope/aspect, noise, outliers and no-data; each quality gate; duo-pitch detection; the compass convention (180 = S) round-trips with the performance engine's `_pvgis_aspect` (`performance.py:50-57`).
- Provenance rules: every write records a source; manual beats derived; a Google source is refused.
- Microgen: `pv_arrays` sum vs site kWp check; reconciliation reports, never corrects; handover idempotence.

**Golden files:**

- PVGIS: the existing 237 kWp Midlands fixture stays; add one per-plane multi-azimuth fixture (E/W pair) recorded once with the live flag.
- LiDAR: one real 5 km composite tile (or a 500 m clip — OGL, storable in the repo) with a known industrial roof; pitch/azimuth pinned to hand-measured values with tolerance ±1° pitch, ±5° azimuth.
- Concept drawing: image snapshot for a fixture project (compare pixels with a tolerance, or compare the SVG path list).
- Handover pack: the existing docx path with the roof table extended (compare extracted text).
- Migration: a fixture `pvdesign.db` with planes in every legacy source → expected `mapping.roof_planes` rows.

**Integration / gateway tests (in-memory stores, existing pattern):** map → planes → layout → compute → issue → handover → arrays, with company scoping and client-role exclusion asserted at each action (extends `tests/test_pvdesign_gateway.py`, `test_mapping.py:202`).

**E2E (hermetic engine + frontend pair, `docs/54` §11):** draw a plane on the Esri canvas, add a rooflight exclusion, pick a module and fixing, auto-layout, delete two cells, run compute, issue, hand over; assert the arrays appear on the Micro-Gen asset tree and the drawing in the pack has no imagery. Plus a keyless run (no `ESRI_API_KEY`) asserting the honest "draw on the street map" message (`tiles.py:183-188`).

**Network-gated live checks (opt-in, like `test_pvdesign_golden_live`):** PVGIS v5_2 and v5_3 answer for a probe point; one LiDAR tile downloads and its checksum matches the cached fixture; Esri capture-date read returns a date for a probe tile.

---

## H. Risks, open questions, and the decisions needed

Each item names the decision James must make. Assumptions made in this document are listed at the end.

| # | Risk / question | What I recommend | Decision needed |
|---|---|---|---|
| H1 | **Frontend repo not audited.** The state of `pv-design-map.tsx` (Google JS vs Leaflet), the existence of any drawing tooling, and any residual `maps.googleapis.com` script load are unknown. | Start the next session with `NZC-Portal/calm-prompt-ai` as the initial source and complete Q1 there before increment 6; increments 1–5 proceed regardless. | Approve a separate frontend audit session. |
| H2 | **Two dormant 2b breach paths** (Q4 a, b) exist in code. | Remove in increment 1 rather than guard. | Confirm deletion (vs keeping behind a flag). |
| H3 | **Roof planes site-owned vs project-owned.** Site-owned is the shared model the brief asks for; it changes `pvdesign`'s ownership and needs a migration. | Site-owned (B.1), projects reference planes. | Yes/no. |
| H4 | **`gateway_site_id` required for drawn geometry.** Today a PV project can exist without a Site. | Required for planes; address-first projects stay allowed but geometry-less until attached. | Yes/no. |
| H5 | **Leaflet vs MapLibre** for the canvas (constraint 2a names MapLibre; the built code is Leaflet). | Keep Leaflet unless the frontend audit shows drawing tooling must be added anyway; then move to MapLibre once. Either satisfies "our content on our map". | Pick one after H1. |
| H6 | **Imagery in exports.** Esri imagery is view-only; today no imagery reaches exports (no Google key). | Exports on OGL layers only (increment 5). | Confirm, or fund a Bluesky/Getmapping data licence that permits print. |
| H7 | **Assessor-grade imagery.** Esri at 30–60 cm and unknown age is adequate for outlines, marginal for rooflights/vents. | Get a Bluesky/Getmapping WMTS quote; treat as optional per-client add-on; imagery date recorded on every plane either way. | Whether to request the quote. |
| H8 | **Esri capture-date metadata** is not proxied, so `imagery_date` cannot be filled automatically today. | Add the read in increment 2 or 6. | None (implementation), but note it makes the mapping module's "imagery items need a date" rule (`mapping_actions.py:27, 219-227`) enforceable for planes. |
| H9 | **LiDAR tile acquisition mechanism** (per-tile URL vs WCS vs manual drop) could not be verified from here (site blocked). | Spike first on three real roofs using the existing `GetFeatureInfo` grid; then implement whichever download route the survey service exposes; keep the manual drop as the offline path. | Approve the spike and the three addresses (the same three the Solar spike never received). |
| H10 | **New dependencies:** `pyproj` (OSTN15 transform), `numpy` (raster maths; `pandas` already pulls it), a GeoTIFF reader (`rasterio` brings GDAL wheels — heavy; `tifffile` + our own georeferencing from the tile name is lighter and stdlib-adjacent). The engine has kept engines stdlib-pure on purpose (`README.md`, `app/rag`). | `pyproj` + `tifffile` + `numpy`; no GDAL. | Accept the dependency change. |
| H11 | **PVGIS v5_2 pinned; v5_3 (SARAH-3) is current.** v5_2 may be retired without notice; v5_3 changes yields slightly, which moves golden numbers. | Make the version a config value (already `NZCAI_PVGIS_API`), record it on every result (already `sourceLabel`), re-record goldens on v5_3 in a dedicated PR. | When to switch. |
| H12 | **OSM tile fallback** contradicts `docs/24:193-194`. With the OS key live it is unused. | Remove the fallback or keep it as an explicitly non-production dev convenience with a banner. | Pick one. |
| H13 | **Wales/Scotland/NI** have no pitch/azimuth derivation in v1. | Refuse with reason (existing pattern), manual entry; NRW LiDAR as increment 7b. | Accept. |
| H14 | **Existing `roof_planes` rows with `source = google_solar`** would need consultant re-confirmation after migration. Likely zero on the live box. | Count before migration; migrate with a `legacy_google_solar` flag and surface. | None unless the count is non-zero. |
| H15 | **Human sign-off (constraint 2d).** The handover pack already carries the DRAFT banner and QA gate (`docs/pv-design.md:99-101`). LiDAR-derived and rule-generated values are new machine outputs. | Every derived value shows its source badge in the UI and the assumptions register; the pack cannot issue with any plane whose pitch/azimuth is `undetermined`. | Confirm the issue-blocking rule. |
| H16 | **Multi-tenant apportionment** of a shared array is outside this plan (microgen allocation, `docs/93` M5) and unchanged by it. | Note only. | — |

### Assumptions made in this document (flagged, not resolved)

1. `nzc-ai-engine` is the repo the brief calls `C:\nzc-group-ai`; `calm-prompt-ai` is "the frontend repo". Based on `docs/BRIEF_CORRECTIONS.md:19` and `docs/54:12`.
2. Every frontend statement is from engine docs dated 2026-08-14/15 and 2026-08-18; the frontend may have moved since.
3. Esri and OS licence/price statements are as recorded by the engine team on 2026-08-14 and 2026-09-06, spot-checked by web search on 2026-09-09; per-licensor flow-down terms for Esri imagery remain unverified (their own open item).
4. Bluesky/Getmapping commercial pricing is unknown; I did not contact them.
5. The EA survey download service's tile URL pattern and the existence of a WCS were not verifiable from this session.
6. PVGIS 5.3 details are from a web search summary of the JRC release page, which itself was unreachable.
7. The test run used Python 3.13, not the pinned 3.14; the suites passed, but that is not the production interpreter.
8. Live-box facts (keys present, Solar off, no `google_solar` rows) are taken from `docs/00`, `docs/86` and `.env.example`; the live `.env` and databases were not inspected.

---

**Stop.** No implementation has been started. Awaiting James's decisions on H1–H15 and approval of the build order in F.
