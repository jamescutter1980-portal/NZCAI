# NZC Portal – Data Source Roadmap and Gap Review

Status: baseline register, September 2026. This repository currently contains no integration code; this document is the reference list the connectors should be built against.

It reviews the external "UK environmental and ESG data catalogue" (GPT analysis, September 2026), records what checked out, what needs correcting, and what fronts it left uncovered. Access labels follow the catalogue: **Open API**, **Commercial API**, **Authorised API** (client consent or account), **GIS/data** (map services or bulk files to import), **Enquiry** (rights to confirm).

---

## 1. Verdict on the catalogue

The catalogue is a sound skeleton. Its structure (asset identity first, then consumption, factors, weather normalisation, hazards, solar, ground, grid, pathways, transport, nature, governance) matches how the portal modules should be layered, and its warnings on traceability, measured-vs-modelled, and separating location-based, market-based and time-varying carbon are correct and should be treated as design requirements.

It is not complete, and several access claims are wrong or out of date. The fronts it misses outright are:

1. **Smart-meter and half-hourly data via consent APIs** (Openvolt, n3rgy) – the cheapest route to measured data for SMEs and residential portfolios.
2. **Heritage and planning constraints on retrofit** (Historic England NHLE, Cadw, HES) – decides what MEES exemptions and fabric measures are even possible.
3. **Air quality and noise** – nothing in the catalogue; both are open DEFRA data and appear in BREEAM, WELL, Fitwel and acquisition due diligence.
4. **Mining and other ground hazards from the Coal Authority** – open WMS, separate from BGS.
5. **Market-based Scope 2 evidence** – AIB residual mix and the Ofgem Renewable Electricity Register are needed to make a market-based figure defensible.
6. **Spend-based Scope 3 with an open factor set** (EXIOBASE) rather than only a commercial wrapper.
7. **Property attributes beyond EPC** – VOA summary valuations (floor areas by floor), HM Land Registry ownership and title polygons.
8. **Grid coverage for the whole of GB** – the catalogue lists three DNOs and misses NGED, SSEN, ENWL and the ENA Embedded Capacity Register.
9. **National solar actuals and roof-level solar modelling** (Sheffield Solar PV_Live, Google Solar API, GivEnergy and other UK inverter/battery APIs).
10. **Supplier ESG screening from official open sources** – gender pay gap employer returns, payment practices reports, the UK Sanctions List, SBTi target export, Contracts Finder.
11. **Heat network zoning** – a live policy constraint for new build and plant replacement in England.
12. **Local socio-economic context** – Index of Multiple Deprivation, ONS Postcode Directory, Census travel-to-work (partly covered via Nomis).

Section 3 lists these with access routes. Section 4 gives the public-API coverage map by portal module.

---

## 2. Corrections to the catalogue (verified September 2026)

| Catalogue claim | Finding | Action |
|---|---|---|
| Government EPC data: "API and bulk CSV" | Correct in substance, but the old Energy Performance of Buildings Data site (epc.opendatacommunities.org) closed to users on 30 May 2026. It is replaced by the **Get energy performance of buildings data** service with a continuing developer API. The wider Open Data Communities platform is moving to open-data.communities.gov.uk (MHCLG Digital blog, 9 July 2026). | Build the EPC connector against the new service endpoints and its documented auth; do not copy older sample code. |
| DESNZ 2026 factors: July correction | Confirmed. DESNZ republished the "flat file for automatic processing" because some unavailable factors (well-to-tank for certain hybrid, CNG and LPG cars; hotel stays in some countries) were shown as 0 instead of blank. The full set was unaffected. | Loader must treat blank as *unavailable*, never as 0; store release date and revision. |
| OS Places API: "licensed API" | OS Data Hub Premium plan gives up to £1,000 per month of premium API transactions free, **excluding OS Places API and OS Match & Cleanse**. OS NGD Features API is inside the allowance. | Budget OS Places separately, or use free alternatives for matching (see §3.1). |
| DVLA VES: "new registrations currently shown as closed" | Not corroborated. Developer portal is live; third-party integrations were still being onboarded in June 2026. Registration is by application with review. | Treat as Open API with an approval step. Confirm at dvlaapiaccess@dvla.gov.uk before promising it to a client. |
| ONS gender pay gap: "statistical benchmarks, not individual employer returns" | Wrong. The **Gender pay gap service** (gender-pay-gap.service.gov.uk) publishes every employer return (250+ staff) as CSV by reporting year, back to 2017/18. | Use employer returns for supplier and client screening; use ONS only for sector benchmarks. |
| OpenSanctions as the sanctions source | Usable, but the free official source is the **UK Sanctions List** (FCDO) in XML/CSV. The OFSI Consolidated List closed on 28 January 2026 and is no longer updated. | Ingest the UK Sanctions List directly; OpenSanctions only if global coverage or fuzzy matching is wanted (commercial licence). |
| ElectraLink QuoteRight | Real. Consented MPAN/meter details and Estimated Annual Consumption; QuoteRight Essentials (meter details) and Dual Fuel variants exist. Aimed at brokers and suppliers. | Commercial API; consent required per site. |
| Xoserve Sustain Plus | Real, but it is the **Gemini Sustain Plus API gateway** for the National Gas transmission system (shippers). Gas supply-point data for buildings comes via Xoserve's Supply Point Quantities API and the Supply Point Enquiry / Meter Asset Enquiry APIs offered through RECCo. | Reclassify: Gemini is not a building-data source. Access to MPRN-level data is via a consumption provider (Perse, ElectraLink) unless the portal becomes a REC party. |
| JBA FLYvis | Real (30 m baseline and future surface-water and river flood layers, plus API and WMTS via JBA Online Services). | Commercial; one of several candidates alongside Fathom, Ambiental and Addresscloud. |
| VOA not mentioned | VOA rating lists and **summary valuations** (floor areas by floor, property description) are downloadable free for 2010, 2017, 2023 and 2026 lists, but under restricted licence terms, not OGL. | Use for floor area and use class; check redistribution terms before showing raw VOA fields in client dashboards. |
| ICE database (implied under embodied carbon) | Free ICE v4.1 is **educational-only after 30 September 2026**. | Do not build commercial embodied-carbon calculations on ICE; use EPDs (ECO Portal, EC3), BECD, and licensed ecoinvent. |
| EA long-term flood risk: "GIS/downloads" | Now **NaFRA2** (rivers, sea and surface water, with UKCP18-based climate allowances). Datasets are on the DEFRA Data Services Platform; Flood Map for Planning moved to a 2 m grid in March 2025. | Ingest NaFRA2 layers with scenario and epoch retained; keep Flood Zones 2/3 separately for planning use. |
| Ofgem REGO register not mentioned | The Renewables and CHP Register was replaced by the **Renewable Electricity Register** (May 2025). Public reports are only partly restored; extracts are circulated via SharePoint on request. | Enquiry. Needed for verifying REGO-backed supply claims. |
| SBTi not mentioned | Target Dashboard (redesigned March 2025) offers machine-readable XLSX by company and by target. No API yet. | Scheduled download into the supplier register. |
| National Chargepoint Registry (not listed, but relevant to fleet) | Decommissioned 28 November 2024. CPOs must publish OCPI reference and availability data openly; Open Charge Map remains an aggregator. | Use Open Charge Map API plus CPO OCPI feeds if EV infrastructure screening is in scope. |
| Heat network zoning not mentioned | England's Heat Networks and Zones Service (beta) launched 2026 with searchable zone maps; authorities submitted zone opportunity areas in May 2026. | Enquiry for data access; at minimum, zone lookup by site. |

---

## 3. Fronts missing from the catalogue

### 3.1 Asset identity and property attributes

| Source | What it adds | Access |
|---|---|---|
| OS OpenUPRN, OS Open USRN, OS Open Linked Identifiers | Free UPRN and street identifiers with coordinates; links UPRN to TOID and USRN | GIS/data (OGL) |
| OS Names API, OS Maps API | Free gazetteer and basemaps under the OpenData plan | Open API |
| postcodes.io | Postcode to coordinates, LSOA, local authority, ward; free | Open API |
| ONS Postcode Directory (ONSPD) | Postcode to every statistical geography, refreshed quarterly | GIS/data (OGL) |
| VOA rating list and summary valuations | Floor area by floor, description, rateable value, list history | GIS/data (restricted licence) |
| HM Land Registry INSPIRE Index Polygons | Title extents for site-footprint risk queries | GIS/data (OGL) |
| HM Land Registry CCOD / OCOD | Company and overseas-company land ownership, England and Wales | GIS/data (free, registered, licence) |
| HM Land Registry Price Paid and UK HPI | Transaction and index data via SPARQL / linked data | Open API |
| Scottish EPC Register open data | Quarterly bulk EPC extract for Scotland (the "provenance" query in the catalogue) | GIS/data |
| EA LIDAR (DEFRA Survey Data Downloads) | 1 m and 2 m DTM/DSM for roof geometry, shading, flood elevation | GIS/data (OGL) |

### 3.2 Consumption and smart-meter data

| Source | What it adds | Access |
|---|---|---|
| Openvolt | Consent-based half-hourly electricity (13 months back) and residential smart meters, API and webhooks | Commercial / Authorised API |
| n3rgy | Consent-based SMETS electricity and gas half-hourly data, supplier-agnostic | Commercial / Authorised API |
| Hildebrand Glowmarkt | Consumer smart-meter data via DCC; useful for residential portfolios | Authorised API |
| Stark, Xoserve DES/GES via RECCo | MPAN/MPRN look-up and supply-point attributes for authorised parties | Commercial / Enquiry |
| DESNZ sub-national consumption statistics | Postcode, LSOA and local-authority gas and electricity totals; benchmarking and estimation where no meter data exists | GIS/data (OGL) |
| DESNZ ND-NEED | Non-domestic energy by sector and floor-area band; benchmark fallback | GIS/data |
| BBP Real Estate Environmental Benchmarks, CIBSE TM46 | Typical and good-practice EUIs by building type | Licensed reference data |

### 3.3 Carbon factors and market-based evidence

| Source | What it adds | Access |
|---|---|---|
| AIB European Residual Mixes (annual, includes GB) | Residual-mix factor for market-based Scope 2 where no contractual instrument applies | GIS/data (free download) |
| Ofgem Renewable Electricity Register | REGO issue and cancellation evidence for supplier green-tariff claims | Enquiry |
| Ofgem Fuel Mix Disclosure | Supplier-level fuel mix and CO₂ | GIS/data |
| EXIOBASE 3 | Open spend-based factors (CC BY-SA), 200 products, UK region; the basis for Climatiq's procurement endpoint | GIS/data (free, Zenodo) |
| Carbon Intensity API regional endpoint | 14 DNO-region half-hourly intensity and mix, 96 h forecast | Open API |

### 3.4 Hazards not covered: heritage, mining, air, noise, coast

| Source | What it adds | Access |
|---|---|---|
| Historic England NHLE (ArcGIS REST, daily refresh) | Listed buildings (points and polygons), scheduled monuments, parks and gardens | Open API / GIS (OGL) |
| Cadw, Historic Environment Scotland, DfC NI | Devolved listed-building and heritage designations | GIS/data |
| Coal Authority WMS layers (via BGS map server) | Coal Mining Reporting Area, mine entries, development high-risk area, past shallow workings | GIS/data (OGL, with public-task restriction) |
| DEFRA UK-AIR Sensor Observation Service | Measured air pollution by monitoring station | Open API |
| DEFRA Pollution Climate Mapping and Air Quality Compliance Data Hub | Modelled 1 km background and roadside concentrations; WMS/WFS/GeoServices | GIS/data (OGL) |
| Air Quality Management Areas | Local authority AQMA polygons | GIS/data |
| DEFRA strategic noise mapping | Road, rail and industry noise contours for England | GIS/data (OGL) |
| EA National Coastal Erosion Risk Mapping | Coastal erosion projections by epoch | GIS/data |
| EA Historic Flood Map, Reservoir Flood Maps, Areas Susceptible to Groundwater Flooding | Complete the flood picture beyond NaFRA2 | GIS/data |
| EA Historic Landfill, Source Protection Zones, Aquifer designation | Contamination context and groundwater sensitivity (open alternatives to commercial screening) | GIS/data |
| EA Water Stressed Areas classification | UK-specific water-stress designation, preferable to Aqueduct for UK sites | GIS/data |
| UKHSA / Met Office heat-health and weather warnings | Operational alerts for overheating and storms | Open feed |

### 3.5 Grid and networks

| Source | What it adds | Access |
|---|---|---|
| NGED Connected Data Portal | Capacity, LTDS, DFES, connections data for the Midlands, South West and Wales | Open data (registration) |
| SSEN Distribution Data Portal | Capacity, generation availability, embedded capacity for north Scotland and central southern England | Open data |
| Electricity North West open data (Opendatasoft) | GSP heat map, capacity datasets for the North West | Open API |
| NIE Networks | Northern Ireland network data | Enquiry |
| ENA Embedded Capacity Register and connections data | Cross-DNO register of connected and contracted resources | GIS/data |
| NESO connections queue and Future Energy Scenarios | Transmission-level constraints and scenarios | Open API |
| Xoserve / nongasmap off-gas-grid postcodes | Whether a site is on the gas network (electrification screening) | GIS/data |
| Heat Networks and Zones Service | Zone lookup for England | Enquiry |

### 3.6 Solar, storage and microgeneration

| Source | What it adds | Access |
|---|---|---|
| Sheffield Solar PV_Live | Half-hourly GB and regional solar actuals; the reference for weather-adjusted generation checks | Open API |
| Google Solar API (buildingInsights) | Roof segments, usable area, shading and yield per building; high-quality UK coverage | Commercial API |
| GivEnergy, Tesla Fleet, SolaX, Fronius Solar.web, SMA ennexOS, Huawei FusionSolar, myenergi | UK-common inverter and battery APIs beyond SolarEdge and Enphase | Authorised API |
| MCS Installations Database | Certified installation counts and capacity by area | GIS/data (aggregate) |
| DESNZ Renewable Energy Planning Database (REPD) | Nearby renewable projects and planning status | GIS/data (OGL) |

### 3.7 Transport and fleet

| Source | What it adds | Access |
|---|---|---|
| VCA car fuel and emissions data | Type-approval CO₂ and consumption by model; fills DVLA gaps | GIS/data |
| DfT anonymised MOT results | Bulk mileage and test data for fleet benchmarking | GIS/data |
| Open Charge Map, CPO OCPI feeds | EV charging locations and availability (NCR decommissioned) | Open API |
| Bus Open Data Service, NaPTAN, TfL Unified API | Public transport accessibility for commuting and site selection | Open API |
| Geotab, Webfleet | Telematics beyond Samsara | Authorised API |
| Concur, Expensify, TravelPerk | Business-travel records for Scope 3 category 6 | Authorised API |

### 3.8 Social, governance and supplier screening

| Source | What it adds | Access |
|---|---|---|
| Gender pay gap service employer returns | Per-employer pay-gap metrics, 2017/18 onward | GIS/data (CSV) |
| Payment practices reporting service (DBT) | Large-company payment terms and performance | GIS/data |
| UK Sanctions List (FCDO) | Official designations in XML/CSV | GIS/data (free) |
| SBTi Target Dashboard export | Supplier climate commitments and validated targets | GIS/data (XLSX) |
| Contracts Finder and Find a Tender APIs | Public procurement footprint | Open API |
| Companies House Streaming API | Change notifications for the supplier register | Open API |
| English Indices of Deprivation, ONSPD | Community context by LSOA | GIS/data |
| Charity Commission register API | As in catalogue; England and Wales only, OSCR and CCNI for the rest | Open API |
| EcoVadis, CDP | Supplier ESG scores; only if clients hold entitlements | Commercial / Enquiry |
| ENCORE | Sector nature dependencies and impacts for TNFD LEAP | GIS/data (open) |

### 3.9 Embodied carbon

| Source | What it adds | Access |
|---|---|---|
| BECD (Built Environment Carbon Database) | UK product and building-level carbon data, 28,000+ products | GIS/data (registration) |
| Ökobaudat | German federal EPD database with open API; useful for generic datasets | Open API |
| One Click LCA | Commercial calculation engine with API, if full WLCA automation is wanted | Commercial API |

---

## 4. Public-API coverage map by portal module

"Primary" is the recommended first connector; "Fallback" is what to use when it is unavailable or out of territory.

| Portal module | Primary public source | Fallback / devolved | Commercial add-on when needed |
|---|---|---|---|
| Asset identity | OS OpenUPRN + postcodes.io + OS Names API | OS Places API (paid, PAF-grade) | Ideal Postcodes / getAddress |
| Building geometry | OS NGD Features API (within free allowance) | OS OpenMap Local, INSPIRE polygons | Bluesky, Verisk |
| EPC / DEC | Get energy performance of buildings data API (E&W) | Scottish EPC Register bulk; NI has no public bulk | Perse enrichment |
| Planning constraints | Planning Data API (England), NHLE ArcGIS REST | Datamap Wales, Scotland spatial data | Landmark, Groundsure |
| Metered energy | Client uploads; Openvolt / n3rgy with consent | DESNZ sub-national statistics for estimates | Perse, ElectraLink, Stark |
| Grid carbon | Carbon Intensity API (national and regional) | Elexon Insights generation mix | – |
| Grid capacity | UKPN, NPg, SPEN, NGED, SSEN, ENWL portals; ENA ECR | NESO Data Portal | – |
| Emission factors | DESNZ annual flat file (versioned); AIB residual mix | EXIOBASE for spend-based | Climatiq, ecoinvent |
| Weather normalisation | Open-Meteo historical (commercial plan) or HadUK-Grid via CEDA | Met Office DataHub (free tier for low volume) | Degree Days.net |
| Climate projections | UKCP18 WPS via CEDA | Copernicus CDS ERA5 and projections | Landmark, Jupiter, XDI |
| Flood | EA Flood Monitoring API (live); NaFRA2 layers (long-term) | SEPA ArcGIS, NRW Datamap, DfI Rivers NI | JBA, Fathom, Addresscloud |
| Ground | BGS open geology WMS; Coal Authority WMS; EA landfill and SPZ | UKradon indicative atlas | BGS GeoSure, Groundsure |
| Air and noise | DEFRA UK-AIR SOS; PCM background maps; DEFRA noise maps | London Air API, OpenAQ | – |
| Solar feasibility | PVGIS; EA LIDAR for roof geometry | Google Solar API (paid) | Solcast |
| Solar performance | Inverter APIs (SolarEdge, Enphase, GivEnergy, Fronius, SMA); PV_Live for expected output | Client CSV | – |
| Biodiversity | Natural England Open Data ArcGIS; NBN Atlas; GBIF; ENCORE | NRW, NatureScot, DAERA layers | IBAT |
| Water | EA hydrology, water quality, catchment APIs; EA water-stressed areas | WRI Aqueduct for overseas suppliers | MOSL route via retailer |
| Transport | DVLA VES; DVSA MOT history; VCA data; DfT traffic API | Open Charge Map | Samsara, Geotab |
| Company and supplier | Companies House API and streaming; UK Sanctions List; gender pay gap; payment practices; SBTi export; Modern Slavery Registry CSV | Charity Commission, OSCR | OpenSanctions, EcoVadis |
| Community context | Nomis, ONS API, IMD, ONSPD | – | – |
| Pathways | CRREM pathway files; UK NZCBS reference tables (both versioned in-portal) | – | – |
| Embodied carbon | ECO Portal API; EC3; BECD | Ökobaudat | ecoinvent, One Click LCA |

---

## 5. Revised integration sequence

The catalogue's order is kept, with three changes: consent-based smart-meter data moves up with the main consumption provider; heritage and planning constraints join the identity phase because they gate retrofit advice; market-based Scope 2 evidence joins the factors phase.

| Priority | Integration group | Outcome |
|---|---|---|
| 1 | OS OpenUPRN / postcodes.io / OS NGD + EPC/DEC new service + NHLE + Planning Data | Stable asset record with certificate history and retrofit constraints |
| 2 | Client uploads + Openvolt/n3rgy consent flow + one commercial provider (Perse or ElectraLink) | Measured energy, HHM analysis, EUI |
| 3 | DESNZ factors (versioned) + AIB residual mix + Fuel Mix Disclosure + EXIOBASE | Location-based, market-based and spend-based Scope 1–3 |
| 4 | Degree days + historical weather (Open-Meteo or HadUK-Grid) | Weather-normalised performance |
| 5 | NaFRA2 + EA Flood Monitoring + SEPA/NRW/NI layers | Present and future flood exposure, live alerts |
| 6 | PVGIS + LIDAR + PV_Live + inverter APIs | Feasibility and actual-vs-expected solar performance |
| 7 | BGS + Coal Authority + EA environmental registers + one commercial screener | Ground and contamination screening |
| 8 | Carbon Intensity API + Elexon + all six DNO portals + ENA ECR | Grid carbon and electrification headroom |
| 9 | CRREM + NZCBS reference data | Pathway and assessment engine |
| 10 | Xero/QuickBooks + DVLA/DVSA/VCA + Open Charge Map | Scope 3 and transport |
| 11 | Natural England / NBN / GBIF / ENCORE + EA water-stress | Nature and water risk |
| 12 | Companies House + UK Sanctions List + gender pay gap + payment practices + SBTi export | Supplier and governance screening |
| 13 | DEFRA air quality and noise | Wellbeing and acquisition context |

---

## 6. Provenance model (mandatory on every imported value)

Every stored value carries: source system, dataset name and version, retrieval timestamp, publication or reporting period, geographic coverage, spatial resolution (postcode centroid, UPRN, footprint), unit, licence (OGL, restricted, commercial, consent-based), required attribution string, refresh cadence, confidence, and a basis flag with one of `measured`, `estimated`, `modelled`, `client_declared`, `unavailable`, `not_applicable`.

Two rules follow from the verified findings above:

- `unavailable` and `not_applicable` are distinct from zero. The DESNZ July 2026 correction is the precedent.
- Consent-based data (Openvolt, n3rgy, inverter APIs, Xero) stores the consent reference and expiry alongside the data, and is purged or frozen when consent lapses.

---

## 7. Technical notes for public-API connectors

- **Key management.** Companies House, DVLA, DVSA, OS Data Hub, Met Office DataHub, Google Solar, CEDA and Copernicus all need per-tenant or per-portal keys with daily limits. Centralise in a secrets store and rate-limit per key.
- **No-key sources.** Carbon Intensity API, Elexon Insights, PVGIS, PV_Live, EA APIs, postcodes.io, NHLE, DEFRA hubs. Cache aggressively and respect published fair-use limits.
- **Geospatial services.** Most hazard and designation layers are ArcGIS REST, WFS or WMS rather than JSON APIs. The portal needs a small spatial query service (PostGIS or equivalent) that ingests these layers on a schedule and answers point-in-polygon and footprint-intersect queries locally. Do not call remote WFS per user request.
- **Footprint, not centroid.** Query flood, ground, heritage and biodiversity layers against the building or title polygon (OS NGD or INSPIRE) and record the resolution used.
- **Devolved coverage.** Every connector records its territory (England, Wales, Scotland, NI, GB, UK). The UI shows "not covered" rather than "no risk" when a site is outside the source's territory.
- **Licence display.** OGL sources need an attribution line in dashboards and exports. VOA and OS premium data need their own notices. Commercial feeds need explicit redistribution rights before any derived value appears in a client report.
- **Versioned reference data in-repo.** DESNZ factors, AIB residual mix, CRREM pathways and NZCBS limits are committed as versioned files with checksums, not fetched at runtime.

---

## 8. Open questions to settle before purchase

1. Which one commercial consumption provider is the default (Perse for coverage, ElectraLink for consent-based EAC), and whether Openvolt/n3rgy consent flows replace it for SME clients.
2. Whether OS Places is worth its separate cost, or free UPRN matching plus OS NGD is enough for the address quality the portal needs.
3. Which commercial flood and ground screener (JBA, Fathom, Groundsure, Landmark) offers dashboard redistribution rights at portfolio pricing.
4. Whether the portal registers for the Renewable Electricity Register public reports to verify REGO claims, or relies on client-supplied supplier statements.
5. Data-access route for Northern Ireland EPCs and network data, which no public API covers.
