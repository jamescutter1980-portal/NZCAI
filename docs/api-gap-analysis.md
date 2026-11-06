# API gap analysis: catalogue versus what is now integrated

Date: 9 September 2026, updated after the second integration pass the same day. Companion to `data-source-roadmap.md` (the catalogue review) and `integrations/data-sources.md` (how to use the sources pages).

## Headline

| | Count |
|---|---|
| Sources registered in the portal | 111 |
| With a working connector and tests | 82 |
| Reference only (contract, registration, bulk download or GIS import; guidance and links, no client) | 29 |
| Operations a user can run from `/sources` | 253 |
| Verified against the live service | 0 |
| Unit tests across connectors and framework | 533 |

Every catalogue source now has an entry. Every entry has a page with its access route, licence, attribution, the keys it needs and whether they are set, and a test-connection button. Every connector operation has a form, a plain-English summary, a table, a provenance line and the raw response. `/lookup` runs all fourteen location-based checks for a postcode or point in one click; `/assets` does the same per building and adds meters, consents and carbon.

**The single biggest gap is live verification.** The build environment's network policy blocks every external host in the catalogue (91 of 92 probed; only Google's API answered, with 403 for a missing key). All 69 connectors were built from documentation, official OpenAPI files and open-source client code, and tested against fixtures. Each carries its unverified points in its notes. Section 4 is the verification plan; it runs from your desktop in under an hour for the open sources.

## 1. Coverage by catalogue group

| Roadmap group | Registered | Connector | Reference only |
|---|---|---|---|
| Building identity, EPCs and constraints | 13 | 9 | 4 |
| Energy consumption and meters | 10 | 5 | 5 |
| Electricity and gas networks | 9 | 7 | 2 |
| Carbon factors and Scope 1-3 | 7 | 5 | 2 |
| Flooding, drainage and water | 13 | 10 | 3 |
| Ground conditions and environmental liabilities | 9 | 7 | 2 |
| Weather, climate and normalisation | 7 | 4 | 3 |
| Solar, batteries and microgeneration | 10 | 8 | 2 |
| Biodiversity, habitats and land | 8 | 6 | 2 |
| Transport, fleet and logistics | 6 | 6 | 0 |
| Social, governance and supplier ESG | 12 | 10 | 2 |
| Embodied carbon and materials | 5 | 3 | 2 |
| Net zero pathways and standards | 2 | 2 | 0 |

### Second pass: reference entries turned into working connectors

Thirteen sources that were reference-only after the first pass now have connectors: Scottish EPC register, DESNZ postcode-level consumption, REPD, VCA fuel data, IMD and ONSPD (streaming loaders for user-placed files, with download where a URL is confirmed); Hildebrand Glowmarkt, Xero and QuickBooks (token-authenticated clients; the OAuth step that obtains the token is documented, not automated); Cadw, Historic Environment Scotland, UKradon, WRI Aqueduct and DEFRA noise (GIS point queries via WFS, ArcGIS REST or WMS). The 29 that remain reference-only are commercial or contract-gated (11), registration-only scientific or enquiry routes (7), or bulk and GIS products with no confirmed point service (11); each carries the access route and what the portal would do with the data.

## 2. Where the build changed the catalogue's assumptions

These came out of reading the providers' current documentation and client code while building, and supersede the roadmap's section 2 where they differ.

- **EPC England and Wales.** The replacement "Get energy performance of buildings data" API is materially different from the old one: Bearer token from GOV.UK One Login, camelCase JSON, `/api/{domestic,non-domestic,display}/search` with postcode, UPRN or address, and `/api/certificate?certificate_number=` using 20-digit RRNs. LMK keys no longer exist and there is **no per-certificate recommendations endpoint** (bulk files only). The connector reads recommendations embedded in the certificate document where present.
- **SSEN data portal.** The API host appears to be `data-api.ssen.co.uk`, not `data.ssen.co.uk`, and the WAF blocks default user agents. Both are configurable.
- **GivEnergy energy flows.** Grouping codes are 0 half-hourly, 1 daily, 2 monthly, 3 yearly, 4 total, not the hourly/daily split the catalogue implied.
- **Samsara fuel and energy report** takes `startDate`/`endDate`, not timestamps.
- **PV_Live** timestamps mark the end of each half hour and the outturn is a modelled estimate, so its basis is "estimated", not "measured".
- **Natural England service names** differ from the obvious ones (`SSSI_England`, `Priority_Habitats_Inventory_England`, `Areas_of_Outstanding_Natural_Beauty_England`).
- **Charity Commission search** route is `/searchCharityName/{name}`.
- **DfT road traffic API** has no server-side point filter; nearby count points are filtered client-side within a local authority.
- **Contracts Finder** has no documented keyword parameter; keyword filtering is client-side.
- **Climatiq** now requires a `data_version` on every call; the default is the July 2026 release and is configurable.
- **UK Sanctions List** has a stable CSV at sanctionslist.fcdo.gov.uk according to current open-source consumers; the OFSI list is closed.
- **Licence labels.** Carbon Intensity, Open-Meteo, PVGIS, WRI Aqueduct and GFW are CC BY; Open Charge Map and EXIOBASE are CC BY-SA; NBN Atlas and GBIF vary per dataset. The provenance model now carries these values instead of lumping them into "restricted".

## 3. What could not be built, and why

| Item | Reason | Route |
|---|---|---|
| Live verification of any connector | All hosts blocked by the build environment's egress policy | Section 4 |
| EPC recommendations by certificate | No such endpoint in the new API | Bulk recommendations files, or embedded data in the certificate document |
| DEFRA PCM modelled background concentrations at a point | Compliance Data Hub feature-service URLs and fields could not be confirmed | Follow-up once a service URL is captured from the hub |
| Catchment Data Explorer point query | Documented `.json` routes return HTML; only GeoJSON by id and the classifications CSV are reliable | Id-based operations shipped; point lookup pending |
| NaFRA2 climate-change layers and four EA constraint services | Service names guessed; rows flag `confirmed_service=false` | Override via `EA_FLOOD_ARCGIS_SERVICES` / `EA_ARCGIS_SERVICES` after checking the ArcGIS directory |
| EA Ecology API parameters | No client code or docs reachable | First thing to verify live |
| Global Forest Watch spatial queries | Query and geostore request shapes unconfirmed | Catalogue operations only |
| ENCORE parser | Download layout unconfirmed | Reference entry |
| Xero and QuickBooks OAuth flows | Need registered apps and an interactive consent flow | Reference entries with scopes documented; QuickBooks is also reachable through the connected MCP in this workspace |
| DESNZ factor file as XLSX | Loader is dependency-free CSV | Export the "Factors by Category" sheet to CSV; documented |
| SBTi targets | XLSX export only, no API | User saves a CSV; search operation provided |
| Heat network zoning, ENA ECR, MCS, REPD, ONSPD/IMD, LIDAR, devolved heritage, Hildebrand, DESNZ sub-national, EA water-stressed areas, GRESB | Bulk, GIS or contract routes | Reference entries with links; several are straightforward imports once the files are in `data/reference/` |

## 4. Verification plan (your desktop, in order)

1. `cp .env.example .env.local`, add the keys you hold, `pnpm dev`, open `/sources`, click **Run all health checks**. Expect the 33 open sources to go green without keys.
2. Run one operation per open source with a real input (a postcode you know, a company number, an MPAN). Compare against the provider's own website. Ten minutes covers Carbon Intensity, Elexon, EA flood monitoring, PVGIS, PV_Live, postcodes.io, Planning Data, NHLE, Land Registry, Natural England, GBIF, NBN, UK-AIR, BGS, Coal Authority, DfT, Nomis, ONS, Contracts Finder, Open-Meteo, UKHSA.
3. Sources with keys you already hold: n3rgy, EPC (needs the new One Login token), Companies House, DVLA, OS Data Hub. Register for the free ones you do not: Met Office DataHub, Charity Commission, Open Charge Map, NBN key.
4. For each verified source, change `status` to `live_verified` in its `index.ts` and delete the notes that no longer apply. Where a response shape differs, paste the raw response into the fixture and adjust the row mapping.
5. Reference loaders: drop the DESNZ 2026 CSV, the AIB residual mix table, and your CRREM and NZCBS extracts into `data/reference/<id>/` per `integrations/reference-data.md`, then run the `years` / `versions` operations.
6. Record outcomes below.

## 5. Per-source register

Generated from the registry. "First thing to verify live" is the first note on each connector.

### Building identity, EPCs and constraints

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [postcodes.io](../src/lib/integrations/postcodes-io) | open | UK | Built, unverified | Look up a postcode; Nearest postcodes to a point; Look up several postcodes | none | No key, no documented hard rate limit; be considerate and cache. |
| [Energy Performance of Buildings register (England and Wales)](../src/lib/integrations/epc-england-wales) | open_key | England and Wales | Built, unverified | Domestic EPCs for a postcode, UPRN or address; Non-domestic EPCs for a postcode, UPRN or address; Display Energy Certificates for a postcode, UPRN or address; Certificate detail; Recommendations for a certificate | EPC_API_TOKEN, EPC_API_BASE?, EPC_API_EMAIL?, EPC_API_KEY? | Covers England and Wales only. Scotland uses the Scottish EPC Register (see scottish-epc-register); Northern Ireland has no public API (see  |
| [OS Data Hub (Names, Places, NGD Features)](../src/lib/integrations/os-data-hub) | open_key | GB | Built, unverified | Find a place, road or postcode (OS Names); Addresses in a postcode (OS Places); Address for a UPRN (OS Places); Match a free-text address (OS Places); Building parts near a point (OS NGD); List NGD collections | OS_DATA_HUB_API_KEY | Plans: OS OpenData plan is free and includes OS Names API. The Premium plan gives up to £1,000 of premium transactions per month free, which |
| [Planning Data (planning.data.gov.uk)](../src/lib/integrations/planning-data) | open | England | Built, unverified | Planning and heritage constraints at a point; Search a dataset by name; List available datasets | none | England only. Completeness varies by local planning authority and dataset: national datasets (listed buildings, scheduled monuments, flood z |
| [National Heritage List for England (Historic England)](../src/lib/integrations/historic-england-nhle) | open | England | Built, unverified | Heritage designations within a distance of a point; Look up a list entry number | NHLE_FEATURESERVER_URL? | Layer ids used: 0 listed building points, 3 listed building polygons, 6 scheduled monuments, 7 parks and gardens, 8 battlefields, 10 world h |
| [Cadw listed buildings, scheduled monuments and conservation areas (Wales)](../src/lib/integrations/cadw-listed-buildings) | gis | Wales | Built, unverified | Cadw designations within a distance of a point | CADW_WFS_BASE?, CADW_WFS_TYPENAME?, CADW_WFS_TYPENAME_SAM?, CADW_WFS_TYPENAME_CONSERVATION? | Type names inspire-wg:Cadw_ListedBuildings, inspire-wg:Cadw_SAM and geonode:conservation_areas_wales are confirmed from DataMapWales layer p |
| [Historic Environment Scotland designations](../src/lib/integrations/hes-designations) | gis | Scotland | Built, unverified | HES designations within a distance of a point | HES_ARCGIS_BASE?, HES_ARCGIS_LAYERS? | Service names Listed_Buildings, Scheduled_Monuments, Conservation_Areas and HES_Designations under https://inspire.hes.scot/arcgis/rest/serv |
| [HM Land Registry open data (Price Paid, UK HPI)](../src/lib/integrations/land-registry) | open | England and Wales | Built, unverified | Sale prices for a postcode; House price index for a region and month | none | Price Paid Data covers residential sales in England and Wales sold for value and lodged for registration since January 1995; it excludes com |
| [VOA non-domestic rating lists (bulk download)](../src/lib/integrations/voa-rating-list) | download | England and Wales | Reference only | Download links and what they contain | none | – |
| [Scottish EPC Register (open data extracts)](../src/lib/integrations/scottish-epc-register) | download | Scotland | Built, unverified | EPCs at a postcode; EPCs for a UPRN; Loaded extract files; Download links | REFERENCE_DATA_DIR? | Supply the files: download the domestic and non-domestic extracts from statistics.gov.scot (ZIP archives named like D_EPC_data_2012-<year>Q< |
| [OS Open UPRN, USRN and Linked Identifiers (bulk)](../src/lib/integrations/os-open-uprn) | download | GB | Reference only | Product and download links | none | – |
| [Northern Ireland EPC register (enquiry)](../src/lib/integrations/ni-epc) | enquiry | Northern Ireland | Reference only | Where to look up NI certificates | none | – |
| [Historic Environment Record of Northern Ireland](../src/lib/integrations/ni-historic-environment) | gis | Northern Ireland | Reference only | Links and access route | none | – |

### Energy consumption and meters

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [n3rgy smart-meter data](../src/lib/integrations/n3rgy) | authorised | GB | Built, unverified | Utilities available for an MPxN; Half-hourly consumption | N3RGY_API_KEY, N3RGY_ENV?, N3RGY_BASE_URL?, N3RGY_HEALTH_MPXN? | Live retrieval requires an active consent record; see /consents. Sandbox MPxNs need none. |
| [Hildebrand Glowmarkt (Bright) smart-meter data](../src/lib/integrations/hildebrand-glowmarkt) | authorised | GB | Built, unverified | List meters (virtual entities) and resources; Half-hourly or daily readings for a resource | GLOWMARKT_USERNAME, GLOWMARKT_PASSWORD, GLOWMARKT_APPLICATION_ID?, GLOWMARKT_API_BASE? | Access route: the occupier installs the Bright app, links their smart meters (DCC consent) and shares the account or, for organisations, Hil |
| [Octopus Energy API](../src/lib/integrations/octopus-energy) | authorised | GB | Built, unverified | Grid supply point for a postcode; List current products; Unit rates for a product and tariff; Account meter points (authorised); Meter consumption (authorised) | OCTOPUS_API_KEY? | Product, tariff and grid-supply-point endpoints are public with no key. Account and consumption endpoints need the account holder's API key, |
| [Openvolt](../src/lib/integrations/openvolt) | authorised | GB | Built, unverified | List connected meters; Meter details; Interval consumption for a meter | OPENVOLT_API_KEY | Commercial service: the portal needs an Openvolt account and a per-meter connection. Consent from the site's energy account holder is captur |
| [DESNZ postcode-level energy consumption](../src/lib/integrations/desnz-subnational-consumption) | download | GB | Built, unverified | Consumption for a postcode; Download a year; Loaded files; Publication pages | REFERENCE_DATA_DIR?, DESNZ_SUBNATIONAL_URLS? | Supply the files: from the gov.uk 'Postcode level electricity statistics: <year>' and 'Postcode level gas statistics: <year>' pages download |
| [ElectraLink QuoteRight](../src/lib/integrations/electralink-quoteright) | commercial | GB | Reference only | – | none | – |
| [Xoserve gas supply point data](../src/lib/integrations/xoserve-gas-data) | commercial | GB | Reference only | – | none | – |
| [Perse](../src/lib/integrations/perse) | commercial | UK | Reference only | – | none | – |
| [Measurabl](../src/lib/integrations/measurabl) | authorised | Global | Reference only | – | none | – |
| [MOSL non-household water market data (CMOS)](../src/lib/integrations/mosl-water-market) | authorised | England | Reference only | How to request MOSL market data | none | – |

### Electricity and gas networks

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [NESO Carbon Intensity API](../src/lib/integrations/carbon-intensity) | open | GB | Built, unverified | National carbon intensity now; National carbon intensity for a date range; Regional carbon intensity now for a postcode; Regional 48-hour forecast for a postcode; National generation mix now; Per-fuel emission factors used by the API | none | Licence is CC BY 4.0 (recorded here in the OGL bucket as the closest open, attribution-only category). Attribution required when values are  |
| [Elexon Insights (BMRS)](../src/lib/integrations/elexon-insights) | open | GB | Built, unverified | Generation by fuel type for a date range; Generation mix for the last 24 hours; National demand outturn; Imbalance (system) prices for a settlement day; Market index (wholesale) prices | none | Licence is Elexon's BMRS data licence (free reuse with the attribution above), recorded in the OGL bucket as the closest open category; it i |
| [NESO Data Portal](../src/lib/integrations/neso-data-portal) | open | GB | Built, unverified | Search datasets; List a dataset's resources; Query a resource table; Open a well-known dataset | none | NESO Open Data Licence v1.0 is derived from OGL v3.0 and stated to be CC BY 4.0 compatible; attribution 'Supported by National Energy SO Ope |
| [DNO open data portals (Opendatasoft)](../src/lib/integrations/dno-open-data) | open | GB (UKPN, Northern Powergrid, SP Energy Networks and Electricity North West licence areas) | Built, unverified | Search datasets on an operator's portal; Find connection capacity and headroom datasets; Fetch dataset records | DNO_OPENDATASOFT_API_KEY? | Licence bucket OGL: most datasets carry OGL v3.0, CC BY 4.0 or the operator's own open licence, but some are restricted. Each result row sho |
| [NGED Connected Data portal](../src/lib/integrations/nged-connected-data) | open_key | England and Wales (East and West Midlands, South West, South Wales) | Built, unverified | Search datasets; List a dataset's resources; Query a resource table; Open a well-known dataset | NGED_API_KEY? | Register at connecteddata.nationalgrid.co.uk to obtain a key; open-source clients send the key as the bare Authorization header value (no 'B |
| [SSEN Distribution open data portal](../src/lib/integrations/ssen-data-portal) | open | GB (central southern England and north of Scotland) | Built, unverified | Search datasets; List a dataset's resources; Query a resource table; Open a well-known dataset | SSEN_DATA_PORTAL_BASE? | API host: the brief listed data.ssen.co.uk, but open-source clients and a 2026-08 probe show the CKAN API at data-api.ssen.co.uk (the portal |
| [National Gas data portal](../src/lib/integrations/national-gas-data) | open | GB | Built, unverified | Download data items by id; NTS gas demand by offtake type; NTS gas supply by source; Daily calorific value for a gas distribution zone; System Average Price (SAP) | none | No key. The portal is public but National Gas does not publish an OGL-style reuse licence for this API; recorded as 'restricted' until redis |
| [Heat Networks and Zones Service (England)](../src/lib/integrations/heat-network-zoning) | enquiry | England | Reference only | Links and access route | none | – |
| [ENA embedded capacity register and connections data](../src/lib/integrations/ena-embedded-capacity-register) | download | GB | Reference only | Links and access route | none | – |

### Carbon factors and Scope 1-3

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [UK Government GHG Conversion Factors (DESNZ)](../src/lib/integrations/desnz-conversion-factors) | download | UK | Built, unverified | Search conversion factors; Get a factor by ID; Loaded reporting years; Publication pages | REFERENCE_DATA_DIR? | Supply the file: download the '<year> flat file for automatic processing' (XLSX) from the gov.uk publication, export the 'Factors by Categor |
| [AIB European Residual Mixes](../src/lib/integrations/aib-residual-mix) | download | Europe incl. GB | Built, unverified | Residual mix for a country and year; Loaded residual-mix rows; AIB publication pages | REFERENCE_DATA_DIR? | Supply the file: transcribe the rows you need from the AIB results (XLSX/PDF per data year) into data/reference/aib-residual-mix/residual-mi |
| [Ofgem Renewable Electricity Register (REGO evidence)](../src/lib/integrations/ofgem-renewable-electricity-register) | enquiry | GB | Reference only | Where to obtain REGO evidence | none | – |
| [Climatiq emission factors](../src/lib/integrations/climatiq) | commercial | Global | Built, unverified | Search emission factors; Estimate emissions from an activity id; Spend-based estimate (procurement) | CLIMATIQ_API_KEY, CLIMATIQ_DATA_VERSION? | Endpoints and parameter names follow the Climatiq API reference (search, estimate, procurement) and public client code; no live call was mad |
| [EXIOBASE 3 (spend-based factors)](../src/lib/integrations/exiobase) | download | Global (49 regions incl. GB) | Reference only | Where to obtain EXIOBASE | none | – |
| [Xero purchase invoices (spend-based Scope 3)](../src/lib/integrations/xero-spend) | authorised | Global | Built, unverified | Purchase invoices (bills) in a date range; Spend by supplier in a date range; Spend by account code in a date range; Supplier contact details | XERO_ACCESS_TOKEN, XERO_TENANT_ID, XERO_API_BASE? | OAuth is out of scope here: the portal's Xero app must run the authorization-code flow with PKCE (scopes accounting.transactions.read, accou |
| [QuickBooks Online purchases and bills (spend-based Scope 3)](../src/lib/integrations/quickbooks-spend) | authorised | Global | Built, unverified | Purchases and bills in a date range; Spend by vendor in a date range; Spend by expense account in a date range | QBO_ACCESS_TOKEN, QBO_REALM_ID, QBO_ENV?, QBO_API_BASE? | OAuth is out of scope here: the portal's Intuit app must run the authorization-code flow (scope com.intuit.quickbooks.accounting), store the |

### Flooding, drainage and water

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [EA flood warnings, river levels, rainfall and tide gauges](../src/lib/integrations/ea-flood-monitoring) | open | England | Built, unverified | Flood warnings and alerts in force near a point; Flood warning and alert areas near a point; River level and flow stations near a point; EA rainfall: gauges near a point with latest totals; EA tide gauges near a point with latest levels; Station detail; Latest readings for a station; Readings for a station since a date; 3-day national flood outlook | none | No key. The service asks for a polite request rate and caches responses; readings are typically 15-minute and appear within an hour or two. |
| [EA Hydrology archive (flow, level, groundwater, rainfall)](../src/lib/integrations/ea-hydrology) | open | England | Built, unverified | Hydrology stations near a point; Time series available at a station; Readings for a measure over a date range | none | No key. The archive holds billions of rows; request only the measure, resolution and window you need. Readings are capped here at 20,000 per |
| [EA flood defence assets (AIMS)](../src/lib/integrations/ea-asset-management) | open | England | Built, unverified | Flood defence assets near a point | none | Alpha API (meta.comment: 'Asset Management API, alpha'); shapes may change. No key. |
| [EA Water Quality Archive (WIMS)](../src/lib/integrations/ea-water-quality) | open | England | Built, unverified | Water quality sampling points near a point; Recent measurements at a sampling point | none | No key; the archive is large (58 million measurements). Measurement queries are capped at 100 rows per call here; narrow by determinand or d |
| [EA Catchment Data Explorer (WFD classifications)](../src/lib/integrations/ea-catchment-data) | open | England | Built, unverified | Water body by id; WFD classifications for an operational catchment; Find a water body for a location (manual) | none | A water-body-near-a-point query could not be confirmed against the published API, so lookups are by water body id (GBxxxxxxxxxxxx) and opera |
| [EA bathing water quality](../src/lib/integrations/ea-bathing-waters) | open | England | Built, unverified | Bathing waters in a district; Nearest bathing waters to a point; Latest sample and classification for a bathing water | none | No key. The bathing season runs 15 May to 30 September; out of season the latest sample can be months old. Annual classifications are publis |
| [EA long-term flood risk (Flood Zones, NaFRA2 rivers, sea and surface water)](../src/lib/integrations/ea-long-term-flood-risk) | gis | England | Built, unverified | Long-term flood risk at a point | EA_FLOOD_ARCGIS_BASE?, EA_FLOOD_ARCGIS_SERVICES? | A desktop point check is not a flood risk assessment. Flood Zones ignore defences and climate change; NaFRA2 accounts for defences and gives |
| [SEPA flood maps (Scotland)](../src/lib/integrations/sepa-flood-maps) | gis | Scotland | Built, unverified | SEPA flood map layers at a point | SEPA_FLOOD_ARCGIS_BASE? | Likelihood bands: high = 10-year return period (10% annual chance), medium = 200-year (0.5%), low = 1000-year (0.1%). Scottish planning poli |
| [NRW flood warnings and alerts (Wales)](../src/lib/integrations/nrw-flood) | open_key | Wales | Built, unverified | Flood warnings and alerts in force near a point (Wales); All flood warnings and alerts in force (Wales); 5-day flood risk outlook (Wales) | NRW_API_KEY | Register at api-portal.naturalresources.wales, subscribe to the open-data products (Live Flood Warnings and Alerts, Flood Risk Forecast, Riv |
| [Flood Maps (NI) - DfI Rivers](../src/lib/integrations/flood-maps-ni) | gis | Northern Ireland | Reference only | Where to check flood risk in Northern Ireland | none | – |
| [JBA Risk Management flood maps, scores and API](../src/lib/integrations/jba-flood) | commercial | Global | Reference only | How to obtain JBA flood data | none | – |
| [WRI Aqueduct 4.0 water risk](../src/lib/integrations/wri-aqueduct) | gis | Global | Built, unverified | Aqueduct water risk indicators at a point | AQUEDUCT_ARCGIS_URL? | Service URL and field names (bws_cat, bws_label, bws_score, name_0, name_1, pfaf_id) are confirmed from open-source point-query clients and  |
| [EA water stressed areas classification](../src/lib/integrations/ea-water-stressed-areas) | gis | England | Reference only | Links and access route | none | – |

### Ground conditions and environmental liabilities

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [EA public registers (permits and registrations)](../src/lib/integrations/ea-public-registers) | open | England | Built, unverified | Permits and registrations near a point; Waste carrier, broker or dealer lookup by name | none | No key. Data is provided under the Environment Agency Conditional Licence (attribution required; do not imply EA endorsement). Page size is  |
| [EA environmental constraints at a point (landfill, SPZ, aquifer, groundwater, coastal erosion, historic flooding)](../src/lib/integrations/ea-environmental-constraints) | gis | England | Built, unverified | Environmental constraints at a point | EA_ARCGIS_BASE?, EA_ARCGIS_SERVICES? | Desktop screening only: a clear result is not proof that land is uncontaminated, and a historic landfill nearby is not proof that it is. A P |
| [BGS geology at a point (bedrock and superficial)](../src/lib/integrations/bgs-geology) | open | GB | Built, unverified | Bedrock and superficial geology at a point (1:50,000); Geology at a point (1:625,000, open data) | BGS_WMS_BASE?, BGS_OGC_API_BASE? | The 1:50,000 WMS is free to use for viewing and point queries under the BGS WMS terms; the underlying DiGMapGB-50 dataset is licensed and mu |
| [Coal Authority mining reporting areas and specific risks](../src/lib/integrations/coal-authority) | open | GB | Built, unverified | Coal mining reporting area and specific risks at a point | COAL_AUTHORITY_WMS_BASE? | Being inside the coal mining reporting area means a CON29M coal mining report is advisable for a transaction; it does not by itself mean the |
| [Defra UK-AIR monitoring (SOS)](../src/lib/integrations/defra-uk-air) | open | UK | Built, unverified | Air quality monitoring stations near a point; Pollutant time series at a station; Recent measurements for a time series; Modelled background maps and AQMA links | none | No key. The SOS is run by a third party and is intermittently unavailable (502s); retry later rather than treating an outage as missing data |
| [Defra strategic noise mapping (England, Round 4)](../src/lib/integrations/defra-noise-mapping) | gis | England | Built, unverified | Road and rail noise levels at a point | DEFRA_NOISE_WMS_ROAD?, DEFRA_NOISE_WMS_RAIL?, DEFRA_NOISE_ARCGIS_BASE?, DEFRA_NOISE_ARCGIS_LAYERS? | Road Round 4 WMS (environment.data.gov.uk/spatialdata/road-noise-all-metrics-england-round-4/wms) is confirmed from the Defra Data Services  |
| [UKradon indicative atlas (UKHSA/BGS radon affected areas)](../src/lib/integrations/ukradon) | gis | UK | Built, unverified | Radon affected-area class at a point | UKRADON_ARCGIS_URL?, UKRADON_MAPSERVER? | Service: BGS GeoIndex radon MapServer (map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/radon/MapServer) via the REST identify operation, |
| [Groundsure environmental and climate reports](../src/lib/integrations/groundsure) | commercial | GB | Reference only | How to obtain a Groundsure report | none | – |
| [Landmark Information Group climate change and environmental reports](../src/lib/integrations/landmark-climate) | commercial | GB | Reference only | How to obtain Landmark reports | none | – |

### Weather, climate and normalisation

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [Open-Meteo](../src/lib/integrations/open-meteo) | open | Global | Built, unverified | Daily weather history with degree days; Daily forecast; Hourly weather history (short range) | OPEN_METEO_API_KEY? | Licence: data CC BY 4.0, free for non-commercial use (under 10,000 calls/day); commercial use needs a subscription and the OPEN_METEO_API_KE |
| [Met Office Weather DataHub](../src/lib/integrations/met-office-datahub) | open_key | Global (UK detail from the UKV model) | Built, unverified | Hourly forecast (next 48 h); Daily forecast (7 days) | MET_OFFICE_DATAHUB_API_KEY | Weather DataHub replaced DataPoint (retired 2024). Site-specific forecasts are the closest equivalent to DataPoint's 3-hourly site forecasts |
| [Degree Days.net](../src/lib/integrations/degree-days-net) | open_key | Global | Built, unverified | Heating and cooling degree days | DEGREE_DAYS_ACCOUNT_KEY, DEGREE_DAYS_SECURITY_KEY | Paid API with per-plan request-unit limits; the response metadata carries requestUnitsAvailable and minutesToReset, surfaced in warnings. |
| [UKHSA Weather-Health Alerts](../src/lib/integrations/ukhsa-weather-health-alerts) | open | England | Built, unverified | Current heat or cold alert for a region | none | Alerts cover England only, by the nine Government Office Regions. The heat season runs 1 June to 30 September and the cold season 1 November |
| [UKCP18 climate projections](../src/lib/integrations/ukcp18) | enquiry | UK | Reference only | How to obtain UKCP18 data | none | – |
| [HadUK-Grid (CEDA)](../src/lib/integrations/haduk-grid-ceda) | download | UK | Reference only | How to obtain HadUK-Grid data | none | – |
| [Copernicus Climate Data Store (ECMWF)](../src/lib/integrations/copernicus-cds) | open_key | Global | Reference only | How to obtain Copernicus CDS data | CDS_API_KEY? | – |

### Solar, batteries and microgeneration

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [PVGIS (JRC)](../src/lib/integrations/pvgis) | open | Europe, Africa, Asia and the Americas (UK covered by PVGIS-SARAH3) | Built, unverified | Annual PV yield estimate; Monthly solar irradiation at a point; Optimal tilt and orientation | none | No key. Rate limit 30 calls/second per IP; PVGIS returns 429 when exceeded and may return 529 under load. |
| [Sheffield Solar PV_Live](../src/lib/integrations/pv-live) | open | GB | Built, unverified | Latest national PV outturn; National PV outturn for a date range; Regional PV outturn by PES or GSP id | none | Licence: Sheffield Solar publishes PV_Live under CC BY 4.0 with attribution required (recorded in the OGL bucket as the closest open categor |
| [Solcast](../src/lib/integrations/solcast) | commercial | Global | Built, unverified | Irradiance forecast at a point; Rooftop PV power forecast; Recent irradiance (estimated actuals) | SOLCAST_API_KEY | Commercial service; the free hobbyist tier is for personal, non-commercial use and returns 429 once its daily quota is used. |
| [Google Solar API](../src/lib/integrations/google-solar) | open_key | Selected countries incl. UK (coverage varies by building) | Built, unverified | Roof solar potential for a building | GOOGLE_MAPS_API_KEY | Billed per request under Google Maps Platform pricing (Building Insights is a paid SKU with a monthly free allowance; check the current pric |
| [SolarEdge Monitoring](../src/lib/integrations/solaredge) | authorised | Global | Built, unverified | List sites; Site overview; Daily energy for a site; Energy by meter (production, consumption, import, export) | SOLAREDGE_API_KEY | The client (site owner) must generate the key and consent to the portal reading their data; record the consent reference in the provenance. |
| [Enphase Enlighten API v4](../src/lib/integrations/enphase) | authorised | Global | Built, unverified | List systems; System summary; Daily production for a range; 15-minute production for one day | ENPHASE_API_KEY, ENPHASE_ACCESS_TOKEN | OAuth 2.0 authorisation-code flow is required: the system owner logs in at Enphase and grants the portal's developer app access; the resulti |
| [GivEnergy Cloud](../src/lib/integrations/givenergy) | authorised | UK | Built, unverified | List inverters; Latest system snapshot; Energy flows for a range | GIVENERGY_API_TOKEN | The account holder creates the token and consents to the portal reading their data; record the consent reference in the provenance. |
| [DESNZ Renewable Energy Planning Database (REPD)](../src/lib/integrations/repd) | download | UK | Built, unverified | Projects near a point; Projects by technology, status and area; Download the latest extract; Loaded extracts; Publication pages | REFERENCE_DATA_DIR?, REPD_CSV_URL? | Supply the file: download the CSV from the gov.uk quarterly extract page and save it as data/reference/repd/repd-q2-2026.csv (any name start |
| [MCS installations database](../src/lib/integrations/mcs-installations) | download | UK | Reference only | Links and access route | none | – |
| [Environment Agency LIDAR (DEFRA Survey Data)](../src/lib/integrations/ea-lidar) | download | England | Reference only | Links and access route | none | – |

### Biodiversity, habitats and land

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [Natural England designated sites and habitats](../src/lib/integrations/natural-england) | gis | England | Built, unverified | Designated sites and habitats within a distance of a point | NATURAL_ENGLAND_ARCGIS_BASE? | Service names are those used by open-source consumers of the Natural England ArcGIS Online organisation (SSSI_England, Special_Areas_of_Cons |
| [NBN Atlas](../src/lib/integrations/nbn-atlas) | open | UK | Built, unverified | Species records near a point | NBN_ATLAS_API_KEY? | Radius is in kilometres around the point; results are paged (pageSize up to 100 here) and facets give counts per species across all matching |
| [GBIF](../src/lib/integrations/gbif) | open | Global | Built, unverified | Occurrences near a point; Match a scientific name | none | No key for search; large extracts should use the download API (needs a GBIF account) which issues a citable DOI. |
| [EA Ecology and Fish Data (Biosys and NFPD)](../src/lib/integrations/ea-ecology) | open | England | Built, unverified | Ecology survey sites near a point; Recent surveys at a site | none | No key. Query parameter names for the sites search (lat, lon, radius in km) and survey filter (site_id) follow the resource names in the API |
| [IBAT (Integrated Biodiversity Assessment Tool)](../src/lib/integrations/ibat) | commercial | Global | Reference only | About IBAT access | none | – |
| [Global Forest Watch Data API](../src/lib/integrations/global-forest-watch) | open_key | Global | Built, unverified | List or search datasets; Dataset detail | GFW_API_KEY | Only the dataset catalogue (GET /datasets, GET /dataset/{name}) is implemented. Spatial queries (POST /dataset/{name}/{version}/query with a |
| [Resource Watch API](../src/lib/integrations/resource-watch) | open | Global | Built, unverified | Search datasets | none | No key for read access. Results are JSON:API documents (data[].attributes); metadata is included with includes=metadata and can be in severa |
| [ENCORE sector dependencies and impacts](../src/lib/integrations/encore) | download | Global | Reference only | Open the ENCORE tool and downloads | none | – |

### Transport, fleet and logistics

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [DVLA Vehicle Enquiry Service](../src/lib/integrations/dvla-ves) | open_key | UK | Built, unverified | Vehicle lookup by registration | DVLA_VES_API_KEY, DVLA_VES_BASE? | Access is by application on the DVLA developer portal and is reviewed; keys are issued for a stated purpose and the terms restrict bulk use. |
| [DVSA MOT History](../src/lib/integrations/dvsa-mot-history) | open_key | GB and NI | Built, unverified | MOT history for a registration; Annual mileage estimate from MOT odometer readings | DVSA_MOT_CLIENT_ID, DVSA_MOT_CLIENT_SECRET, DVSA_MOT_API_KEY, DVSA_MOT_TOKEN_URL, DVSA_MOT_SCOPE? | Access requires registration with DVSA (trade API); credentials arrive by email and the client secret expires periodically. Tokens are cache |
| [VCA car fuel data](../src/lib/integrations/vca-fuel-data) | download | UK | Built, unverified | Search by make and model; Loaded years; VCA car fuel data downloads | REFERENCE_DATA_DIR? | Supply the files: from the VCA downloads page fetch the CSV (current 'Euro 6 latest' file, or an archive year's file, unzipped) and save it  |
| [DfT road traffic statistics](../src/lib/integrations/dft-road-traffic) | open | GB | Built, unverified | Count points in a local authority (optionally nearest a point); Annual average daily flow for a count point | none | Unauthenticated; the API paginates with page[number] and page[size] and returns a data[] envelope with links.next. No latitude/longitude fil |
| [Open Charge Map](../src/lib/integrations/open-charge-map) | open_key | Global | Built, unverified | Charge points near a point | OPEN_CHARGE_MAP_API_KEY | Data is community-maintained with operator imports; status and connector counts can be stale. Verify before relying on a specific site for a |
| [Samsara Fleet](../src/lib/integrations/samsara-fleet) | authorised | Global | Built, unverified | List vehicles; Fuel and energy report for a date range | SAMSARA_API_TOKEN, SAMSARA_API_BASE? | Commercial telematics: the client creates a read-only API token in their Samsara organisation and shares it under a data-sharing agreement.  |

### Social, governance and supplier ESG

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [Companies House](../src/lib/integrations/companies-house) | open_key | UK | Built, unverified | Search companies by name; Company profile; Officers; Persons with significant control; Filing history; Charges (secured debt) | COMPANIES_HOUSE_API_KEY | Rate limit: 600 requests per 5 minutes per key; the API returns HTTP 429 when exceeded. |
| [UK Sanctions List (FCDO)](../src/lib/integrations/uk-sanctions-list) | download | UK | Built, unverified | Screen a name against the UK Sanctions List; Download the latest list | UK_SANCTIONS_LIST_URL?, REFERENCE_DATA_DIR? | The OFSI Consolidated List of Asset Freeze Targets closed on 28 January 2026; the UK Sanctions List is the only official UK source. |
| [Gender pay gap service](../src/lib/integrations/gender-pay-gap) | download | UK | Built, unverified | Download a reporting year; Look up an employer for a year; Compare an employer across years | REFERENCE_DATA_DIR? | Download URL pattern https://gender-pay-gap.service.gov.uk/viewing/download-data/2024 (year = start of the reporting year) is taken from the |
| [Modern slavery statement registry](../src/lib/integrations/modern-slavery-statement-registry) | download | UK | Built, unverified | Download a statement year; Search statements by organisation or company number | REFERENCE_DATA_DIR? | Download URL pattern https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads/StatementSummaries2025.csv and the c |
| [Payment practices reporting (DBT)](../src/lib/integrations/payment-practices-reporting) | download | UK | Built, unverified | Download the full export; Payment performance for a company | PAYMENT_PRACTICES_CSV_URL?, REFERENCE_DATA_DIR? | The export URL (https://check-payment-practices.service.gov.uk/export/csv/) and column names (Company, Company number, Start date, End date, |
| [SBTi Target Dashboard](../src/lib/integrations/sbti-targets) | download | Global | Reference only | Open the SBTi Target Dashboard; Search a saved dashboard export | REFERENCE_DATA_DIR? | – |
| [Contracts Finder and Find a Tender (OCDS)](../src/lib/integrations/contracts-finder) | open | UK | Built, unverified | Contracts Finder notices by keyword and date; Find a Tender releases updated in a window | none | Contracts Finder has undocumented request throttling; on HTTP 403 the documentation asks for a 5-minute pause. Requests are limited here to  |
| [Charity Commission register](../src/lib/integrations/charity-commission) | open_key | England and Wales | Built, unverified | Search charities by name; Charity details; Financial history | CHARITY_COMMISSION_API_KEY | Routes confirmed from open-source clients: /searchCharityName/{name}, /allcharitydetails/{regno}/{suffix}, /charityoverview/{regno}/{suffix} |
| [Nomis (ONS labour market and census)](../src/lib/integrations/nomis) | open | UK | Built, unverified | Search datasets; Find geography codes; Fetch data for a dataset and geography; Census 2021 travel to work mode (TS061) for an area | none | No key needed; anonymous calls are limited to 25,000 cells per request and Nomis asks for a UID (free registration) for heavier use. |
| [ONS Beta API](../src/lib/integrations/ons-api) | open | UK | Built, unverified | List or search datasets; Dataset detail; Observations for a dataset | none | No key. The observations endpoint needs one option per dimension (or '*' for exactly one dimension, capped at 10,000 observations); dimensio |
| [English Indices of Deprivation and ONS Postcode Directory](../src/lib/integrations/ons-geography-imd) | download | England (IMD); UK (ONSPD) | Built, unverified | Deprivation for an LSOA; Deprivation for a postcode; Download an IMD edition; Loaded files; Publication pages | REFERENCE_DATA_DIR?, IMD_FILE7_URL? | Supply the IMD file: from the gov.uk 'English indices of deprivation 2019' (or 2025) page download 'File 7: all ranks, deciles and scores fo |
| [GRESB](../src/lib/integrations/gresb) | commercial | Global | Reference only | Links and access route | none | – |

### Embodied carbon and materials

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [ECO Platform ECO Portal (EPDs)](../src/lib/integrations/eco-platform-eco-portal) | open_key | Europe | Built, unverified | Search EPDs by name; EPD detail: GWP by module | ECO_PORTAL_TOKEN | Register at data.eco-platform.org, then generate an API token in the user profile; tokens expire and must be renewed. The token is sent only |
| [ÖKOBAUDAT (BBSR)](../src/lib/integrations/okobaudat) | open | Germany (generic datasets used across Europe) | Built, unverified | List data stocks (releases); Search datasets by name; Dataset detail: GWP by module | none | No key. Data stocks are versioned releases (e.g. 'OBD_2024_I'); list them first and search within the release you intend to cite so results  |
| [EC3 (Building Transparency)](../src/lib/integrations/ec3-building-transparency) | open_key | Global (US-centric) | Built, unverified | Search materials / EPDs; EPD detail | EC3_API_TOKEN | Obtain a token in EC3 under Settings > API & Integrations after creating an account with a business email; tokens can be revoked and re-issu |
| [Built Environment Carbon Database (BECD)](../src/lib/integrations/becd) | download | UK | Reference only | Where to obtain BECD data | none | – |
| [ecoinvent (licensed LCI database)](../src/lib/integrations/ecoinvent) | commercial | Global | Reference only | Where to obtain ecoinvent | none | – |

### Net zero pathways and standards

| Source | Access | Territory | Status | Operations | Keys or files | First thing to verify live |
|---|---|---|---|---|---|---|
| [CRREM decarbonisation pathways](../src/lib/integrations/crrem-pathways) | download | Global (UK pathways included) | Built, unverified | Pathway series; Misalignment year for an asset; Loaded CRREM versions | REFERENCE_DATA_DIR? | Supply the file: export the pathway tables from the CRREM tool or the published pathway workbook into data/reference/crrem-pathways/<version |
| [UK Net Zero Carbon Buildings Standard limits](../src/lib/integrations/uk-nzcbs) | download | UK | Built, unverified | Limits for a sector and year; Loaded Standard versions | REFERENCE_DATA_DIR? | Supply the file: transcribe the limit and target tables from the published Standard (technical document and its annexes) into data/reference |

## 6. Verification log

| Date | Source | Result | Notes |
|---|---|---|---|
| | | | |
