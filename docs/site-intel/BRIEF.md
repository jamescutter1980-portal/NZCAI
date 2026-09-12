# NZC AI — Site Intelligence Layer (S-01 to S-03)
### Claude Code build brief · 11 September 2026 · scope: NZC AI only (not NZC Portal)

Save to the engine repo as `docs/site-intel/BRIEF.md`.

---

## 0. Read this first

**What we're building.** A consultant types an address or clicks the map. NZC AI works out which building it is and returns a **Site Profile**:

- the building's address ID (UPRN), title extent and footprint (**S-01**)
- the planning and environmental constraints on it (**S-02**)
- nearby grid capacity (**S-03**)

The profile is stored on the building record, shown on the map, and fed to the skills, RFIs and reports. The idea comes from Searchland, rebuilt from free UK open data.

**Rules that override everything else:**

1. **Free and open data only.** Use OGL data, or data under a licence that allows commercial reuse. No Searchland, no paid APIs. Google Maps and the Solar API stay only where they're already approved (see 3.4).
2. **Deterministic Python for every derived value.** The local Ollama model may only write narrative from flags that already exist. No site or client data goes to DeepSeek or the Anthropic API.
3. **Every value carries lineage:** source, dataset ID, licence, `retrieved_at`, `source_updated`, method and quality tier.
4. **Flags, not decisions.** Outputs are screening flags for review by a qualified person. The system must never say "no constraints". A result where nothing was found must say whether coverage was complete.
5. **No live network calls in CI.** Use recorded fixtures.

**Before writing code:**

- Inspect both repos (engine and frontend). Reuse what already exists:
  - the single reusable map component (MapLibre by default, Google on paid tiers)
  - the EPC/TM44 register retrieval module
  - the Watershed-lift work if built: single data spine (W-11), data-quality tiers (W-03), lineage and cited AI (W-23)
- If W-11, W-03 or W-23 aren't built yet, add a minimal compatible `SourceRecord` and tier enum, and note it for later merging.
- Write `docs/site-intel/PLAN.md` covering what you found, the storage decision (section 2) and anything that blocks you. Then carry on.

---

## 1. Task 0 — EPC register endpoint check (housekeeping)

EPC open data has moved to **get-energy-performance-data.communities.gov.uk**. The old `epc.opendatacommunities.org` API has no published retirement date.

- Check which endpoint the register retrieval module calls.
- If it's the legacy API, add a migration ticket to `PRELAUNCH.md`. Don't break the current integration.
- S-01 relies on this module for UPRN matching, so confirm domestic, non-domestic and DEC lookups by postcode all still return UPRNs.

---

## 2. Architecture

```
engine/site_intel/
  models.py        # SiteProfile, SourceRecord, Constraint, Substation, EcrEntry (pydantic)
  sources.yaml     # registry: every dataset, URL, licence, attribution string, refresh cadence
  resolve.py       # S-01
  constraints.py   # S-02
  constraint_rules.yaml  # flag -> wording key; wording signed off by James
  grid/
    base.py        # DnoAdapter interface
    nged.py  ukpn.py  npg.py  ssen.py  spenw.py  spen.py
  cache.py         # per-source TTL cache
  jobs.py          # bulk refresh jobs (OS, DNO layers)
  service.py       # get_profile(), refresh_profile()
```

- **API** (existing FastAPI app, port 8077):
  - `GET /api/site-intel/profile?building_id=|uprn=|lat=&lon=|address=`
  - `POST /api/site-intel/profile/{building_id}/refresh`
  - `PATCH /api/site-intel/profile/{building_id}/override`, for a user-confirmed pin or redrawn footprint
- **Storage decision (write an ADR in `docs/site-intel/`).** The bulk geodata is large: OS Open UPRN is about 40M points, plus OS OpenMap Local buildings and the DNO layers.
  - Recommended default: a **local PostGIS container on the EVO-X2** for bulk reference data.
  - Supabase holds the app records (`site_profile`, overrides, lineage).
  - Check whether Supabase already has PostGIS and enough storage before deciding.
- **Cache TTLs** (config): planning.data 7 days; DNO headroom = the source's publish cadence, capped at 30 days; OS bulk refreshed on each OS release.
- **Roles.** Follow the existing role model. Consultant and business users can view profiles for buildings they can access. Refresh and override follow existing edit rights.

---

## 3. S-01 — Resolve the building

### 3.1 Resolution chain (stop at the first confident match)

| Step | Input → output | Source | Confidence |
|---|---|---|---|
| a | Address/postcode → UPRN | Existing EPC register module (postcode search, fuzzy address match) | `exact` if address and UPRN match |
| b | UPRN → coordinates | **OS Open UPRN** (bulk; `https://api.os.uk/downloads/v1/products/OpenUPRN`) | inherits |
| c | Postcode only → centroid | **OS Code-Point Open** (bulk; product `CodePointOpen`) | `approximate`, user must pin |
| d | No match → geocode | Existing Google key (capped), used **only to find candidate UPRNs** within 25 m | `probable`, user must confirm |
| e | User clicks map | Nearest OS Open UPRN within 25 m of the click | `manual` |

**Google terms.** Check the Google Maps Platform terms on storing geocodes and showing them on non-Google maps. Design so **persisted coordinates always come from OS Open UPRN**, never from Google.

### 3.2 Title extent and footprint

- **Title extent.** Query planning.data.gov.uk dataset **`title-boundary`** by point (HM Land Registry index polygons, OGL, about 22.7M entities, England, marked incomplete).
  - Fallback / phase 2: the HMLR **INSPIRE Index Polygons** bulk download (England & Wales, monthly, OGL) loaded into PostGIS.
  - Multiple polygons at the point → keep all of them and flag `multi_title`.
- **Building footprint.** Load **OS OpenMap Local** building polygons into PostGIS (bulk; product `OpenMapLocal`).
  - Pick the polygon containing the UPRN point. If none contains it, pick the largest polygon intersecting the title extent and flag `footprint_inferred`.
  - Users can redraw the footprint on the map. Store that as an override tier and keep the original.
- **Location context:** country (E/W/S) and local planning authority, via planning.data `local-planning-authority` or `local-authority-district` (confirm slug).

### 3.3 Output fields

`uprn, lat, lon, postcode, country, lpa_code, lpa_name, title_extents[] (geom, area_m2, source_ref), footprint (geom, area_m2, method), match_confidence, user_confirmed, sources[]`

### 3.4 UI

- A "Is this the building?" confirm step: pin plus footprint highlight, with Confirm / Move pin / Redraw buttons.
- Layers in the existing map component: title extent (outline) and footprint (fill).
- Attribution must show whenever these layers are visible.
  - **Copy the exact wording from each source's licence page.** Store it in `sources.yaml`, not hard-coded.
  - Title polygons need both the HM Land Registry statement and the OS statement: "The polygons (including the associated geometry, namely x, y co-ordinates) are subject to Crown copyright and database rights [year] Ordnance Survey AC0000851063."
  - OS OpenData products need the standard OS OpenData attribution.

---

## 4. S-02 — Planning and environmental constraints

### 4.1 Query

- **Primary source:** planning.data.gov.uk `GET /entity.json`:
  - `geometry=<footprint WKT>&geometry_relation=intersects&dataset=…&dataset=…` (repeatable), with `limit`/`offset` paging.
  - A second query on a **50 m buffer** (configurable) gives `proximity` results, e.g. the setting of a listed building.
  - Apply polite rate limiting. Use bulk dataset downloads for portfolio runs over 50 buildings.
- **Resolve dataset slugs at startup** from `/dataset.json`. If a configured slug is missing, fail loudly in the health check. Don't silently skip it.
- **England only.** Welsh and Scottish sites return status `not_supported` with a clear message (phase 2: DataMapWales, SpatialData.gov.scot).

### 4.2 Datasets and why they matter

| Slug (confirm) | NZC AI relevance |
|---|---|
| `conservation-area` | Rooftop PV, external insulation and window works may need consent; MEES/EPC exemption review |
| `listed-building`, `listed-building-outline` | Listed building consent for works; EPC/MEES exemption review |
| `locally-listed-building`, `heritage-at-risk` | Informational heritage flag |
| `article-4-direction-area` | Permitted development rights may be removed |
| `area-of-outstanding-natural-beauty`, `national-park`, `world-heritage-site`, `world-heritage-site-buffer-zone` | Designated land, which restricts some PV permitted development |
| `scheduled-monument`, `park-and-garden` | Heritage consent |
| `flood-risk-zone` | Physical climate risk for CRREM/TCFD sections |
| `tree-preservation-zone`, `ancient-woodland` | Ground-mount PV, ground-source heat pumps, external works |
| `site-of-special-scientific-interest`, `special-area-of-conservation`, `special-protection-area`, `ramsar-site` | Ecology constraints; links to the biodiversity skill |
| `green-belt` | Ground-mount PV and extensions |
| `air-quality-management-area` | Siting of biomass, CHP and air-source heat pumps |

- **Flood cross-check.** Also query the Environment Agency **Flood Map for Planning – Flood Zones** (environment.data.gov.uk) as the authoritative source. Record which source produced the flag. If the two disagree, show both and flag `source_conflict`.
- Surface-water flood risk is out of scope for phase 1.

### 4.3 Result states (per dataset, per building)

`present` · `proximity` · `not_found_coverage_complete` · `not_found_coverage_unknown` · `not_supported` · `source_error`

- Check whether planning.data exposes per-LPA provision or coverage for each dataset (organisation/provision endpoints).
- Where coverage can't be confirmed, return `not_found_coverage_unknown`, **never** a plain "not found".

### 4.4 Wording

- Code returns states and rule keys only.
- `constraint_rules.yaml` maps each key to short user-facing text and a "what to check" line. **James signs off all wording.**
- Don't encode planning law (GPDO classes, thresholds) in Python.

---

## 5. S-03 — Grid capacity

### 5.1 Which DNO

Use point-in-polygon against the **NESO "GIS Boundaries for GB DNO Licence Areas"** GeoJSON (neso.energy data portal). Store the version date.

### 5.2 Adapters

Build a common interface in `grid/base.py`:

```python
class DnoAdapter(Protocol):
    def supply_area(self, point) -> SubstationArea | None: ...      # polygon containing site, if published
    def substations_near(self, point, radius_m) -> list[Substation]: ...
    def headroom(self, substation_id) -> Headroom | None: ...
    def ecr_near(self, point, radius_m, min_kw) -> list[EcrEntry]: ...
```

**Build order:** NGED first (covers the Midlands), then UKPN, NPg, SSEN, SP ENW, SPEN.

| DNO | Portal | Starting datasets (confirm IDs, fields, licence) |
|---|---|---|
| NGED | connecteddata.nationalgrid.co.uk | `network-opportunity-map-headroom`; Embedded Capacity Register |
| UKPN | ukpowernetworks.opendatasoft.com | `primary-substation-headroom`, `grid-and-primary-sites`, `ukpn_primary_postcode_area`; ECR |
| Northern Powergrid | northernpowergrid.opendatasoft.com | `heatmapsubstationareas`; ECR |
| SSEN Distribution | data.ssen.co.uk | Headroom / heat map; ECR |
| SP Electricity North West | electricitynorthwest.opendatasoft.com | `enwl-gsp-heatmap`, HV circuits capacity; ECR |
| SP Energy Networks | SPEN open data portal / heat map pages | Heat map; ECR |

- **Licence check.** Record each dataset's licence in `sources.yaml`. **Leave out any dataset whose licence doesn't allow commercial reuse,** log it in `PLAN.md` and tell James.
- Some portals may require free registration or an API key. Keys go in the existing gitignored `.env`.

### 5.3 Normalised schema

- `Substation`: `dno, id, name, level (GSP|BSP|primary|secondary), geom, area_geom?, gen_headroom_mw?, demand_headroom_mw?, gen_rag?, demand_rag?, source_date, source_ref`
- `EcrEntry`: `dno, id, technology, export_mw, import_mw?, status (connected|accepted), geom, distance_m, source_date`

### 5.4 Logic (deterministic, thresholds in config)

1. If the DNO publishes a supply-area polygon, use the polygon that **contains the site**. Otherwise use the nearest N primaries within the radius and label them `nearest_by_distance`.
2. ECR: entries within 2 km (configurable) with export of 50 kW or more, summarised by technology and status.
3. Screening flags:
   - `pv_export_screen`: compare generation headroom with proposed PV export. Take the export figure from the PV design module if one exists; otherwise leave the flag unrated.
   - `electrification_screen`: compare demand headroom with estimated added load. Take the load from audit data if present (heat pump and EV); otherwise unrated.
   - Output green / amber / red / unrated.
   - Any G98/G99 or other threshold values live in config and are signed off by James.
4. **Every grid output carries fixed wording:** "Indicative only — based on published DNO data dated [date]. Not a connection offer. A connection application to [DNO] is required."
5. Data older than 90 days → set tier to stale and show an amber warning.

### 5.5 UI

- Map layers: substations (coloured by RAG), supply-area polygon, ECR generators (by technology).
- Profile panel: DNO, the containing or nearest substations, headroom figures, ECR summary, screening flags and the fixed wording.

---

## 6. Lineage, tiers and attribution

- Every field in the profile links to one or more `SourceRecord`s: `{source_id, dataset, entity_ref, licence, attribution, retrieved_at, source_updated, method, tier}`.
- **Tiers.** Use W-03 tiers if they exist. Otherwise:
  - T1: register or authoritative exact match
  - T2: open-data spatial match
  - T3: inferred (nearest, approximate)
  - T4: user override
  - Stale: past its TTL
- **Report appendix.** Auto-generate a "Site data sources and limitations" appendix listing every source with dates, licences, attribution strings and coverage caveats.

---

## 7. Integration

- **Service call:** `site_intel.get_profile(building_id)` for skills and report generators.
- **MCP tool (read-only):** `site_intel_profile(building_id | uprn | address)` in the NZC AI MCP layer. Same lineage in the response.
- **Consumers (add hooks, don't rewrite the skills):**
  - **MEES / non-domestic EPC:** listed or conservation flags → prompt for exemption review.
  - **Solar PV design:** constraints and `pv_export_screen` shown on the design screen. Footprint seeds roof area when Google Solar isn't used.
  - **CRREM / TCFD:** flood zone feeds the physical risk narrative.
  - **EPC / NZCBS:** flag `floor_area_check` when footprint area × storeys differs from EPC floor area by more than 25%. Storeys come from user input or the EPC; the check is informational.
  - **RFI pre-fill:** auto-sourced fields are marked "auto-sourced — please confirm" and aren't counted as client-answered until confirmed.
- **LLM narrative guard.** The model may only describe flags that exist and must cite their `source_id`. A test fails if generated text says "no constraints", "no flood risk" or "grid capacity available" without the matching state and caveat.

---

## 8. Build phases

| Phase | Scope | Done when |
|---|---|---|
| P1 | Task 0 + S-01 resolve, confirm UI, storage ADR, OS bulk loads | Address → confirmed UPRN, title and footprint on the map, with lineage |
| P2 | S-02 constraints + flood cross-check + rules YAML | Profile panel lists constraint states with sources and coverage |
| P3 | S-03 NGED adapter end-to-end, then the other five DNOs | DNO found, supply area or nearest substations, headroom, ECR, screens |
| P4 | Integration: skills hooks, RFI pre-fill, MCP tool, report appendix | A report run includes the site appendix; the MCP tool returns the profile |

Commit per phase, keep CI green, and update `PRELAUNCH.md` with status.

---

## 9. Testing and acceptance

**Fixture sites.** Pick 8 and ask James to confirm them. Record API responses into `tests/fixtures/site_intel/`. Cover:

1. a listed building in a conservation area
2. a site in Flood Zone 3
3. a commercial unit with a non-domestic EPC (exact UPRN match)
4. an address with no EPC (Google candidate path)
5. a title containing several buildings
6. a Welsh address (`not_supported` path for S-02)
7. one site in each of at least three DNO areas
8. an LPA with incomplete planning.data coverage

**Tests:**

- Unit tests: resolution chain, state logic, every DNO normaliser, threshold screens, rules mapping, attribution rendering.
- Golden files: full `SiteProfile` JSON for each fixture.
- Contract tests (nightly, not CI): hit live sources and alert on schema drift, a missing dataset slug or a licence change.
- E2E: address → confirm → profile panel → report appendix → MCP tool call.
- Narrative guard test (section 7).

**Performance:** profile under 5 s with a warm cache, under 15 s cold, for a single building. Portfolio of 100 buildings as a background job with progress.

**Acceptance checklist:**

- [ ] No paid or unlicensed source in `sources.yaml`; every source has a licence and attribution
- [ ] Stored coordinates are never Google-derived
- [ ] Every profile field has lineage and a tier
- [ ] Nothing-found constraint results always say whether coverage was complete
- [ ] Grid outputs always carry the "indicative, not a connection offer" wording and the data date
- [ ] Wording and thresholds live in YAML/config, flagged for James's sign-off
- [ ] Welsh and Scottish sites degrade cleanly
- [ ] CI green with no network access

---

## 10. Out of scope (later briefs)

- Ownership: company-owned property data + Companies House (S-04)
- VOA floor area and use class (S-06)
- Natural-language site search (S-07)
- MEES prospect list (S-08)
- Planning application history
- Welsh and Scottish constraints
- Surface-water flooding
- Biodiversity habitat screening
- Any paid source
- Any NZC Portal integration

---

## 11. Report back to James

A short summary covering:

- what was built
- the storage decision
- datasets left out on licence grounds
- DNO coverage achieved
- items needing his sign-off (constraint wording, grid thresholds, fixture sites)
- known coverage gaps
