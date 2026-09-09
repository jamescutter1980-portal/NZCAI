# Reference data files

Some connectors read versioned factor tables and pathways from disk instead of calling a service (roadmap §7: "versioned reference data in-repo, not fetched at runtime"). The files are supplied by you, live under `data/reference/<connector id>/` (gitignored, so they never enter version control by accident), and are read only by those connectors via `REFERENCE_DATA_DIR` (default `data/reference`). Header-only templates are in `docs/integrations/reference-data-templates/`.

Rules that apply to every file:

- UTF-8 CSV, comma separated, quoted fields allowed. A BOM and CRLF are tolerated.
- **A blank value means "not available" and is never read as 0.** A published 0 is a genuine zero. This is the DESNZ July 2026 precedent (roadmap §6).
- Provenance for every value carries the file name and its modification time (`version`), the publication where the row records one, and a basis of `measured` (published tables loaded verbatim), `modelled` (pathway values) or `unavailable` (blank).
- Versions are immutable: add a new file for a new release; do not edit a file that has already been used in a report. Record where each file came from (publication, release date, checksum) in your own change log.
- Files are parsed once and cached until their mtime or size changes; no restart is needed after replacing a file.

| Connector | Directory | File name | Columns |
|---|---|---|---|
| `desnz-conversion-factors` | `data/reference/desnz-conversion-factors/` | `<year>.csv` (e.g. `2026.csv`) | `ID, Scope, Level 1, Level 2, Level 3, Level 4, Column Text, UOM, GHG/Unit, GHG Conversion Factor <year>` |
| `aib-residual-mix` | `data/reference/aib-residual-mix/` | `residual-mix.csv` | `data_year, country_code, country, residual_mix_gco2_per_kwh, direct_co2_only, publication, publication_date, source_url` |
| `crrem-pathways` | `data/reference/crrem-pathways/` | `<version>.csv` (e.g. `v2.04.csv`) | `version, country_code, property_type, pathway_type, scenario, year, value, unit` |
| `uk-nzcbs` | `data/reference/uk-nzcbs/` | `<version>.csv` (e.g. `v1.0.csv`) | `version, sector, metric, year, limit_value, unit, notes` |

## desnz-conversion-factors

Source: DESNZ, "UK Government GHG Conversion Factors for Company Reporting", published each June under OGL v3.0, one page per year:

- https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026 (flat file republished 31 July 2026: some unavailable factors had been shown as 0)
- https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2025
- https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2024

Steps:

1. Download the "**flat file for automatic processing**" (XLSX) for the reporting year.
2. Open the `Factors by Category` sheet and export it as CSV (UTF-8). The sheet starts with a few title rows; leave them, the loader finds the header row by its first cell `ID`. Extra lookup columns after the factor column are ignored.
3. Save as `data/reference/desnz-conversion-factors/<year>.csv`.

The header is checked on load: `ID, Scope, Level 1, Level 2, Level 3, Level 4, Column Text, UOM, GHG/Unit` must be present and one column must start with `GHG Conversion Factor`. Rows whose `GHG/Unit` is `kg CO2e` are the reporting totals; per-gas rows are kept but hidden unless requested. Scope values are `Scope 1`, `Scope 2`, `Scope 3`, `Outside of scopes`.

Location-based Scope 2 = `UK electricity` generation factor + `Transmission and distribution` factor (WTT rows are Scope 3). Market-based Scope 2 uses supplier factors or, without a contractual instrument, the AIB residual mix.

## aib-residual-mix

Source: Association of Issuing Bodies, European Residual Mixes, https://www.aib-net.org/facts/european-residual-mix (results for year N published around May of N+1; the 2025 results were published in May 2026). Transcribe the rows you need:

| Column | Meaning |
|---|---|
| `data_year` | Year the electricity was consumed |
| `country_code` | ISO 3166-1 alpha-2 as used by AIB (`GB`) |
| `country` | Name |
| `residual_mix_gco2_per_kwh` | Residual mix factor, gCO2/kWh; blank if AIB publishes none |
| `direct_co2_only` | `true` if the figure is direct CO2 only (AIB's main table), `false` if CO2e |
| `publication` | e.g. `AIB European Residual Mixes 2025, Final Results` |
| `publication_date` | ISO date of the publication used |
| `source_url` | URL of the PDF/XLSX the value came from |

Apply the residual mix only to electricity with no contractual instrument. REGO-backed supply needs cancellation evidence on the Ofgem Renewable Electricity Register (see the `ofgem-renewable-electricity-register` notes).

## crrem-pathways

Source: CRREM pathway tables (CRREM tool / published pathway workbook), https://www.crrem.eu/tool/. Confirm software-use rights with CRREM before embedding pathway values in client-facing tools. One file per CRREM release, e.g. `v2.04.csv`:

| Column | Values |
|---|---|
| `version` | CRREM release, repeated per row (`v2.04`) |
| `country_code` | ISO alpha-2 (`GB`) |
| `property_type` | CRREM property type name (`Office`, `Retail, High Street`, ...) |
| `pathway_type` | `ghg` or `energy` |
| `scenario` | `1.5C` or `2C` |
| `year` | Calendar year |
| `value` | Pathway value; blank if none |
| `unit` | `kgCO2e/m2` or `kWh/m2` |

Pathway values carry basis `modelled`. The misalignment operation reports the first year the asset series exceeds the pathway; a single asset value is held constant, which is a static projection, not the CRREM tool's method.

## uk-nzcbs

Source: UK Net Zero Carbon Buildings Standard, https://www.nzcbuildings.co.uk/. Transcribe the limit and target tables from the published Standard into `<version>.csv` (e.g. `v1.0.csv`):

| Column | Values |
|---|---|
| `version` | Standard version (`v1.0`) |
| `sector` | Sector name as in the Standard |
| `metric` | Key such as `operational_energy_eui`, `embodied_upfront`, `embodied_lifecycle`, `onsite_renewables`, `refrigerant_leakage`, `space_heating_demand` |
| `year` | Year the limit applies (completion or reporting year); blank if not year-specific |
| `limit_value` | The limit; blank where the Standard sets none |
| `unit` | `kWh/m2/yr`, `kgCO2e/m2`, ... |
| `notes` | Floor-area basis, scope, table reference |

This is a reference table, not a calculation API, and is kept separate from CRREM.

## Not file-based

`climatiq`, `eco-platform-eco-portal`, `okobaudat` and `ec3-building-transparency` call their services directly (keys in `.env.local`: `CLIMATIQ_API_KEY`, `ECO_PORTAL_TOKEN`, `EC3_API_TOKEN`). `exiobase`, `ecoinvent`, `becd`, `xero-spend`, `quickbooks-spend` and `ofgem-renewable-electricity-register` are reference-only definitions whose notes explain how access would work.
