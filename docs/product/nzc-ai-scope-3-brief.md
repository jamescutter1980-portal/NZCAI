# NZC AI — Feature Brief: Scope 3 for multi-brand site operators

**Workstream:** NZC AI platform (engine repo + frontend repo), occupier / operating-company branch
**Owner:** James Cutter · **Build agent:** Claude Code with the existing deterministic-engine conventions
**Status:** Draft v1, 9 September 2026 · for build/priority decision
**Trigger:** Welcome Break (Applegreen group) selected Watershed for Scope 3, citing the number of franchise and concession partners on its sites (KFC, Starbucks, Burger King, Waitrose, WHSmith and others)

> **This is Layer 1: boundary, ledger, factors, engines and outputs.** It is deliberately a recording system. Welcome Break's ESG manager's follow-up — that a ledger with basic in and out is not a Scope 3 offering — is answered by **Layer 2, `nzc-ai-scope-3-engagement-brief.md`**: the counterparty graph, engagement lifecycle, public-first enrichment, document intelligence, the chase engine, the inbound Request Inbox and the agent fleet. Section 6 below is superseded in detail by that brief. Build them in parallel; Layer 1 computes, Layer 2 obtains and evidences.

---

## 0. How to use this brief

Read top to bottom before touching code. Section 1 says why. Section 2 defines the customer archetype the module must serve. Section 3 is the boundary and method rulebook the engine must encode. Sections 4 to 8 are the build: data model, engines, collection, outputs, UI. Section 9 is phasing, Section 10 acceptance, Section 11 hard constraints. Do not invent scope beyond Section 8; do not skip anything in Section 3.

Work in small committed increments; keep the existing engine tests, skill golden files and E2E path green after every phase. Ask James only when a decision is irreversible; otherwise choose the option consistent with Section 11 and record it in docs/decisions/.

---

## 1. Why this module, why now

### 1.1 What NZC AI has today

- `ghg-protocol-carbon-report` skill and `calculate_footprint.py`: Scope 1, dual Scope 2, and Scope 3 categories 1 (spend-based), 3, 5, 6 and 7 with DESNZ 2025 factors. Built for organisations that hold their own data.
- ECR ledger brief: meter-level Scope 1 and 2 with landlord/tenant perspective flips (category 13 for the landlord). Not built.
- `sbti-advisory` skill: 67% coverage test, 5% exclusion test, category screening RFI.
- `csrd-advisory` skill: ESRS E1 datapoints, Wave 2 thresholds, Omnibus rules including the VSME value-chain cap.
- `circular-economy-advisory` skill: notes that waste data should pre-populate category 5 and that supplier circularity scorecards "sit in the supply chain section of the portal". That section does not exist.
- Client RFI portal, consent workflow (Portfolio Intelligence brief), PDF extraction, evidence trail. Partly built or specified.

Nothing product-ises categories 2, 4, 8 to 15. Nothing handles a franchisee, a franchisor, a concession tenant or a fuel seller. Nothing scores data quality or produces the primary/secondary split ESRS E1-6 requires.

### 1.2 What the lost client needed

Welcome Break: some 60 locations including 32 motorway service areas and 31 hotels, 6,000+ staff, 85 million customers a year. It is the **franchisee-operator** of KFC, Starbucks, Burger King, Taco Bell, Subway, Greggs, Pret, PizzaExpress, Krispy Kreme and Chopstix, a **retail partner** of Waitrose and WHSmith, a **landlord** to concession and charging tenants (Tesla, GRIDSERVE, Revolution Laundry), a **hotel franchisee** (Ramada, Days Inn, Wyndham) and a **fuel retailer**.

Its parent Applegreen (Dublin; €3.85bn revenue 2025; ~15,000 staff; 435 sites in Ireland, the UK and the US; taken private by Blackstone Infrastructure and B&J Holdings in 2021) has a net-zero 2050 goal across Scopes 1 to 3, has completed a first Scope 3 assessment, and is developing a transition plan "aligned with Science Based Targets". Three external forces land on Welcome Break at once:

| Force | Requirement | Implication for the operator |
|---|---|---|
| CSRD Wave 2 (Applegreen: >1,000 employees and >€450m turnover) | First sustainability statement in 2028 covering FY2027 under ESRS 2.0; E1-6 gross Scope 3 by category with primary vs secondary data split; limited assurance | UK subsidiary must deliver an assurable category-level inventory for FY2027, so the FY2026 baseline year is now |
| SBTi criterion C22 | Any company selling fossil fuels must set a separate 1.5°C-aligned category 11 target regardless of share; near-term targets must cover 67% of Scope 3; exclusions under 5% | Fuel sold on Welcome Break forecourts is a mandatory target line; the 67% test almost certainly pulls in category 1 (food and packaging) too |
| Franchisor targets (Yum! Brands: 46% per-restaurant reduction by 2030 with franchisees; Starbucks, Wyndham similar) | Franchisor requests restaurant-level energy, waste and packaging data from franchisees | Welcome Break must report **upwards** to brands and **sideways** to Applegreen from the same dataset |

Peer pressure is also explicit: Extra MSA became the first motorway service operator with SBTi-validated net-zero targets in 2025 and publishes a Scope 3 supply-chain roadmap to 2050.

Watershed sells exactly this: all 15 categories, spend-based via CEDA, supplier engagement, CSRD builder, assurance guarantee. It does not sell site energy engineering, ESOS, MEES or landlord/concession splits. The opportunity is a Scope 3 module that is native to **multi-brand, multi-site UK operators** and reuses the site-level ledger NZC already plans.

### 1.3 Target segment beyond Welcome Break

Motorway and A-road service operators (Moto, Roadchef, Extra, Applegreen UK); forecourt groups (EG Group, MFG, Rontec); pub, restaurant and hotel franchisees; retail landlords with concession-heavy schemes (outlet villages, travel hubs); NHS and university estates with franchised catering. All share the pattern: many outlets under brands they do not own, shared site energy, high food and packaging spend, waste as a top-five category, and a parent or lender demanding CSRD, UK SRS or SBTi outputs.

---

## 2. Customer archetype the module must serve

**Organisation:** a UK operating subsidiary of a larger (often EU or PE-owned) group.
**Structure:** Organisation → Region → Site → Outlet (brand, format, operator role) → Cost centre / meter.
**Roles the same company can hold on one site:** franchisee (operates a brand under licence), franchisor (licenses its own brand out), retail partner (operates a third-party brand under a supply agreement), landlord (leases space to a concession that operates independently), tenant (leases the site from a highway authority or landowner), fuel and electricity retailer.
**Data owners:** finance (purchase ledger), procurement (brand-mandated distributors such as Bidfood and Brakes), site operations (meters, waste contractors), franchisors (brand-level product footprints), concession tenants (their own meters), fuel supplier (litres), EV charging partner (kWh).
**Obligations:** ESRS E1-6 for the parent, SBTi near-term and net-zero, SECR for the UK entity, franchisor annual data requests, lender ESG KPIs.

The module must let one dataset answer all of those without re-keying.

---

## 3. Boundary and method rulebook (encode in the engine, test with golden files)

### 3.1 Operator role determines scope per outlet

| Outlet operator role | Outlet energy | Outlet purchases (food, packaging) | Outlet waste | Where it lands in the operator's inventory |
|---|---|---|---|---|
| Franchisee (operates a brand it does not own) | Scope 1/2 of the franchisee | Category 1 of the franchisee | Category 5 | Franchisor counts the same outlet in **its** category 14 |
| Franchisor (licenses out its own brand) | Category 14 (franchises) | Category 14 | Category 14 | Optional: also request franchisee primary data |
| Landlord to a concession | Category 13 (downstream leased assets) | Not in boundary | Category 5 only if operator contracts the waste | Concession tenant counts it as its own Scope 1/2 |
| Retail partner under supply agreement | Scope 1/2 | Category 1 | Category 5 | Same as franchisee |
| Fuel retailer | Scope 1/2 for the forecourt | Category 1 for fuel purchased for resale (extraction, refining, WTT) | — | **Category 11** for combustion of fuel sold (SBTi C22 mandatory target) |
| EV charging (operator-owned chargers) | Electricity purchased is Scope 2 of the operator; electricity sold to drivers is reported gross unless a pass-through election is documented | — | — | Disclose kWh sold and treatment; do not double count with category 11 |
| EV charging (partner-owned chargers, e.g. GRIDSERVE, Tesla) | Category 13 if space is leased; otherwise out of boundary | — | — | Document the contractual basis |
| Hotel franchisee (Ramada, Days Inn) | Scope 1/2 | Category 1 | Category 5 | Wyndham counts it in its category 14 |

Every outlet carries an `operator_role` and a `contract_basis` note. Changing the role re-scopes the outlet automatically and writes an audit row.

### 3.2 Shared site energy allocation

Shared services (amenity building HVAC, car park lighting, forecourt canopy) are allocated to outlets by sub-meter where present, otherwise by floor area, with the allocation method stored on each allocated figure. Allocation is required for franchisor reporting (per-restaurant intensity) and for category 13 (concession share). It never changes the organisation total.

### 3.3 Method hierarchy per category (GHG Protocol Scope 3 Standard, Technical Guidance)

| Tier | Method | Data quality score (1 = best) | Example |
|---|---|---|---|
| A | Supplier-specific | 1 | Franchisor-supplied product carbon footprint per menu item; supplier EPD; distributor-reported logistics tCO₂e |
| B | Hybrid | 2 | Supplier-reported Scope 1/2 allocated by share of spend or volume |
| C | Average-data (physical) | 3 | kg of chicken × DESNZ or Agribalyse factor; tonnes of packaging by material; litres of fuel × DESNZ combustion factor; tonnes of waste by treatment route |
| D | Spend-based (EEIO) | 4 | £ by supplier and GL code × Open CEDA (UK-adjusted) or DESNZ spend factor |
| E | Estimated / extrapolated | 5 | Prior-year figure scaled by revenue; flagged for replacement |

Rules: every category figure records its tier, factor source, factor version and the share of the category total that is primary (tiers A and B) versus secondary (C to E). ESRS E1-6 requires that split; SBTi requires an improvement plan. The engine reports both automatically. A figure can never be computed by an LLM; the LLM may only propose a GL-to-sector mapping or draft a data request, and every proposal is human-confirmed before it affects a number.

### 3.4 Category 11 for fuel sold

`litres sold by fuel type × DESNZ "fuel combustion" factor` for the operator's inventory. WTT for the same fuel sits in category 1 if the operator buys the fuel for resale, or is out of boundary if the forecourt is operated by the fuel company under a licence (role = landlord, category 13). Both patterns exist on the UK motorway network; the outlet role decides.

### 3.5 Screening and exclusions

All 15 categories are screened every year with a quantified estimate, even where the answer is "not relevant". Exclusions are stored with a reason code and a tCO₂e estimate; the engine enforces the SBTi 5% cap and the ESRS requirement that exclusions be justified.

---

## 4. Data model (Supabase, schema `s3`)

Additions to the ECR ledger; reuse `organisation`, `site`, `meter`, `reading`, `evidence` and `audit_row`.

| Table | Purpose | Key fields |
|---|---|---|
| `s3_outlet` | An operated unit within a site | site_id, brand_id, format (restaurant, drive-thru, retail, forecourt, hotel, ev_hub, concession), operator_role, contract_basis, floor_area_m2, opened, closed |
| `s3_brand` | Brand and its owner | name, franchisor_org, franchisor_target (text), reporting_template_id |
| `s3_partner` | Any value-chain counterparty | type (supplier, distributor, franchisor, concession_tenant, waste_contractor, fuel_supplier, charging_partner, logistics), legal name, company number, contact, employee_band (for the VSME <1,000 rule), data_agreement_status |
| `s3_spend_line` | Purchase-ledger row | period, partner_id, gl_code, description, amount_gbp, currency, vat_excluded flag, capex flag, intercompany flag, outlet_id nullable, mapped_sector_id, mapping_confidence, mapping_confirmed_by |
| `s3_activity_line` | Physical activity row | period, category, outlet_id nullable, quantity, unit (kg, tonne, litre, kWh, tkm, pkm, nights, £), item_id (menu item, material, fuel type, waste route), source (invoice, distributor feed, franchisor, manual), evidence_id |
| `s3_partner_response` | Supplier-specific data | partner_id, period, scope1_t, scope2_t, allocation_basis, pcf_items (json), verification_status, evidence_id |
| `s3_factor` | Factor library | source (DESNZ year, Open CEDA version, Agribalyse, WRAP, supplier EPD), category applicability, unit, value, uncertainty_band, valid_from, valid_to, licence |
| `s3_sector_map` | GL/keyword to EEIO sector | gl_code pattern, keyword pattern, sector_id, default_tier, confidence |
| `s3_category_result` | Computed result | org_id, period, category, tCO2e, tier_breakdown (json), primary_share, factor_versions (json), excluded flag, exclusion_reason, computed_at, engine_version |
| `s3_allocation` | Shared-energy allocation | site_id, period, method (submeter, floor_area, hours, revenue), outlet_id, share |
| `s3_data_request` | Outbound request | partner_id, template (VSME, franchisor, concession_energy, waste, logistics), sent_at, due, reminders, status, token |
| `s3_target` | Targets and coverage | scope, categories, base_year, target_year, reduction_pct, method (ACA, SDA, engagement), coverage_pct computed |

Row-level security follows the existing consultant / business roles. Partner-facing rows are exposed only through tokenised request pages.

---

## 5. Engines (pure Python, deterministic, golden-tested)

| Engine | Function |
|---|---|
| `s3/screen.py` | 15-category relevance screen from organisation profile (sector, roles, spend totals); produces the annual screening table with estimates |
| `s3/spend_map.py` | Maps spend lines to EEIO sectors using `s3_sector_map`; unmapped lines go to a review queue; local LLM may propose a mapping with a confidence, human confirms; capex, VAT, intercompany and payroll excluded by rule |
| `s3/eeio.py` | Spend × Open CEDA (UK-adjusted, inflation- and currency-adjusted to factor year) or DESNZ spend factor; stores factor version |
| `s3/activity.py` | Physical quantity × factor for categories 1, 4, 5, 6, 7, 9, 11, 12 including food items (Agribalyse / WRAP / Poore-Nemecek style factors by ingredient class), packaging by material, fuel by type, waste by route |
| `s3/partner.py` | Supplier-specific and hybrid allocation from `s3_partner_response`; falls back to lower tier where a response is missing and flags it |
| `s3/leased.py` | Category 13 and category 8 from the ECR meter ledger using outlet operator roles and `s3_allocation` |
| `s3/franchise.py` | Category 14 for franchisors; per-outlet intensity packs for franchisees reporting upward |
| `s3/fuel_sold.py` | Category 11 from litres sold; EV kWh sold treatment per Section 3.1 |
| `s3/quality.py` | Tier, data-quality score and primary/secondary share per category; year-on-year improvement tracking |
| `s3/coverage.py` | SBTi 67% and 5% tests; ESRS exclusion justification check; mandatory category 11 flag for fuel sellers |
| `s3/hotspots.py` | Ranked contributors by category, partner, brand, site, ingredient class; what-if levers (menu mix, packaging material, waste diversion, EV substitution of fuel sold, supplier switch to a lower-factor response) |
| `s3/consolidate.py` | Roll-up from UK entity to parent with entity tags and FX table; export in the parent's chart of categories |

All arithmetic lives here. The frontend and the LLM read results; they never compute.

---

## 6. Data collection

> Summary only. The full design — counterparty graph, engagement states, enrichment before asking, document intelligence, chase cadence, inbound obligations, agents — is in `nzc-ai-scope-3-engagement-brief.md` (Layer 2). Items 4 and 5 below are the parts that brief replaces outright.

1. **Purchase ledger import.** CSV/XLSX templates plus connectors for Xero, Sage, QuickBooks and NetSuite exports; dedupe partners; company-number enrichment. Import history and validation report as in the ECR unit upload.
2. **Distributor feeds.** Brand-mandated distributors (Bidfood, Brakes, Martin Brower, Starbucks supply) can supply line-level product volumes by outlet. Template with item, kg, outlet, period; maps to tier C automatically and to tier A when the distributor also supplies item footprints.
3. **Franchisor data.** Brand-level product carbon footprints and packaging specs from franchisor sustainability teams (Yum!, Starbucks, RBI, Wyndham publish or share on request). Stored as `s3_partner_response` with `pcf_items`.
4. **Partner data requests.** *(Superseded by Layer 2 §5–§8.)* Reuse the RFI portal and consent wizard: tokenised page, reminders, evidence upload. Templates: VSME-basic for suppliers (the Omnibus cap means a supplier under 1,000 employees can refuse anything beyond VSME, so ask for VSME by default), concession energy consent (category 13), waste contractor annual return by route, logistics tkm return, fuel supplier litres by type. Layer 2 adds: enrichment and pre-fill before any request, the engagement state machine, tiering and ranked effort, back-planned cadence with a contact escalation ladder, cross-client fatigue control, reply-by-email ingestion, PACT and VSME machine exchange.
5. **Bill and invoice OCR.** *(Superseded by Layer 2 §7.)* Existing PDF extraction writes to `s3_activity_line` with confidence; one-click accept writes an auditable row. Layer 2 generalises this into document intelligence: every inbound or harvested artefact becomes a typed Document with an extraction schema, a validity window that drives automatic re-chase, conflict detection against the counterparty's other disclosures, and a confidentiality basis enforced on read and export.
6. **Meter ledger.** Site and outlet energy come from the ECR ledger; no re-entry.

Every request, response, reminder and confirmation writes an audit row. Bill-payer and supplier contact PII follows the existing retention job.

---

## 7. Outputs

| Output | Content | Consumer |
|---|---|---|
| Scope 3 inventory statement | 15 categories, tCO₂e, tier breakdown, primary/secondary share, exclusions with justification, methodology sheet with every factor version | Board, auditors |
| ESRS E1-6 datapoint export | Gross Scope 3 by category, primary/secondary split, base year, intensity per net revenue, entity tags for consolidation | Parent's CSRD team (Applegreen-shaped) |
| SBTi readiness pack | Coverage test, exclusion test, mandatory category 11 flag, proposed target boundary, improvement plan by category | sbti-advisory skill, SBTi submission |
| Franchisor packs | Per-brand, per-outlet energy, waste, packaging, intensity in the franchisor's template | Yum!, Starbucks, RBI, Wyndham requests |
| SECR statement | Scope 1, 2, optional Scope 3 lines, intensity ratio | UK entity annual report |
| Hotspot and lever report | Top contributors and modelled reductions with cost where known | Operations, procurement |
| Data-quality roadmap | Per category: current tier, target tier, partners to engage, expected primary share next year | Sustainability lead |
| XLSX with method sheet | All of the above with factors, sources and NA rules | Assurance provider |
| Branded docx | Via `ghg-protocol-carbon-report` extended to all categories and `nzc-portal-report-branding` | Client deliverable, human sign-off gate |

---

## 8. Frontend (React/Vite, `src/features/scope3/*`, mounted at `/scope3/*`)

Screens: **Overview** (15-category bar with tier colouring, primary share, coverage tests as status chips), **Sites & Outlets** (role editor, allocation), **Spend** (import, mapping queue, partner list), **Activity** (physical data by category), **Partners** (requests, responses, VSME status, reminders), **Categories** (one page per category with method, lines, factors, evidence), **Targets** (coverage tests, SBTi boundary builder), **Hotspots & Levers**, **Exports**. Same shell, counters, column chooser and pagination as Portfolio Intelligence. Every number shows its tier chip and opens its lineage on click.

Chat/MCP tools: `s3_category_summary`, `s3_coverage_status`, `s3_partner_status`, `s3_data_gaps`, `s3_explain_figure` (returns the lineage for a figure). Local model answers "why did category 1 rise 12%?" from engine outputs only.

---

## 9. Phasing (each phase ends with green CI and a demo note)

| Phase | Weeks | Deliverable |
|---|---|---|
| S1 Foundation | 1–2 | Schema, outlet roles, factor library loaded (DESNZ 2025, Open CEDA current release, food and packaging classes), screening engine, golden fixtures shaped on a 32-site multi-brand operator |
| S2 Spend | 3–4 | Ledger import, sector mapping with review queue, EEIO engine, Spend and Categories screens, category 1 and 2 results with tiers |
| S3 Activity and site | 5–6 | Activity import, OCR bridge, distributor template, category 3, 4, 5, 6, 7 engines, category 8/13 from the ECR ledger with allocation, category 11 fuel sold |
| S4 Partners | 7–8 | Supplier-specific and hybrid tiers, category 14. **Collection itself is Layer 2 phases E1–E6, running in parallel from week 1** — this phase consumes what E2–E4 deliver |
| S5 Outputs | 9 | Quality and coverage engines, ESRS E1-6 export, SBTi pack, franchisor packs, SECR, XLSX with method sheet, branded docx |
| S6 Insight | 10 | Hotspots and levers, consolidation to parent, chat tools, data-quality roadmap |

Depends on ECR P1 (ledger) for categories 8 and 13; everything else can proceed in parallel with the ECR programme.

---

## 10. Acceptance (self-verified, reported pass/fail)

1. Fixture: 32 sites, 180 outlets across nine brands with mixed roles, 24 months of ledger (40,000 spend lines), distributor volumes for two brands, fuel litres for 20 forecourts, concession meters on 12 sites. Total Scope 3 reproduces a spreadsheet recomputation within ±0.5%.
2. Changing one outlet from franchisee to landlord moves its energy from Scope 2 to category 13, its purchases out of category 1, and writes an audit row; totals reconcile.
3. Category 11 equals litres × DESNZ combustion factor per fuel type; WTT lands in category 1 only where role = fuel retailer purchasing for resale.
4. A franchisor PCF response for one brand raises that brand's category 1 tier to A and the organisation's primary share rises by exactly the brand's spend share.
5. Coverage engine: on the fixture the 67% test passes only when categories 1, 5 and 11 are all in the target boundary; category 11 is flagged mandatory; a 6% exclusion set fails the 5% test with the named categories.
6. ESRS E1-6 export lists every category with primary/secondary split and every exclusion with a justification and estimate.
7. A supplier flagged under 1,000 employees receives the VSME template, never the ESRS template.
8. Franchisor pack for one brand reproduces per-outlet kWh, kgCO₂e and waste tonnes consistent with the site allocation method stored on each figure.
9. No LLM call is on the path to any number (grep test on the engine package); mapping proposals are stored with confidence and confirmed_by before use.
10. Every figure on every screen opens a lineage showing source rows, factor version and tier.

---

## 11. Hard constraints

1. Numbers come only from `s3/*.py` engines and SQL views.
2. Client data stays local (Supabase on the EVO-X2). Outbound calls: accounting-package exports uploaded by the client, partner request emails via M365 Graph, factor downloads at build time, Anthropic API for regulatory watch only.
3. Factor licences respected: Open CEDA is CC BY-SA and must be attributed and its derivative tables shared alike; DESNZ is OGL; supplier data is used only for the requesting client.
4. Every mutation writes an audit row; every report keeps the qualified sign-off banner.
5. No Watershed naming, wording or layout copied; parity is functional.
6. Feature flags `scope3`, `s3_llm_mapping`, `s3_partner_requests` default off in production until Phase S5 passes.

---

## 12. Commercial packaging

- **Tier:** "Enterprise / Operating Company" adds Scope 3 to the Compliance and Portfolio tiers. Price per site per year plus a partner-request allowance; consultant white-label available.
- **Proof point to build first:** a motorway or forecourt operator willing to be the design partner, with a fixed-fee FY2026 baseline engagement (consultancy) that seeds the module with real data.
- **Sales message:** "One dataset for the parent's CSRD statement, the SBTi boundary, SECR, and every franchisor's annual request, with site energy, ESOS and MEES already in the same system."

---

## 13. Open questions for James (do not block S1)

1. Design partner: approach Welcome Break's ESG team for the site-side and franchisor-pack work Watershed does not cover, or start with another MSA operator?
2. Food factors: license a commercial ingredient database or rely on Agribalyse plus WRAP and DESNZ classes for v1?
3. EV kWh sold: default to gross reporting with a documented election, or ask the client each time?
4. Should Open CEDA be UK-adjusted in-house (price level and grid mix) or used as published for v1 with a disclosed limitation?
5. Layer 2 carries its own open questions (PACT conformance registration, auto-send policy, the consented data commons, mailbox model) — see that brief §19.
