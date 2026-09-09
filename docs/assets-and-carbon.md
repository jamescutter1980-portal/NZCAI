# Assets, screening and carbon

An **asset** is a building or site: name, address, postcode, UPRN, coordinates, floor area, property type. Assets link to **meters** (MPxN, utility, direction) so that stored readings, consents, carbon and environmental screening roll up per building. A shared supply can be linked to several assets.

## Pages and routes

| Surface | Purpose |
|---|---|
| `/assets` | List and add assets. Coordinates are filled from the postcode via postcodes.io (centroid, not footprint). |
| `/assets/<id>` | Asset detail: meters with consent and reading status, energy and carbon by year, one-click screening with results by section, screening history. |
| `GET/POST /api/assets`, `GET/PATCH/DELETE /api/assets/<id>` | CRUD. |
| `POST/DELETE /api/assets/<id>/meters` | Link and unlink meters; a supplier-specific Scope 2 factor and its evidence can be recorded per meter. |
| `POST /api/assets/<id>/geocode` | Fill coordinates from the postcode. |
| `POST /api/assets/<id>/screen` | Run the screening profile and store the result. |
| `GET /api/assets/<id>/carbon?year=` | Energy, Scope 1, Scope 2 (location, market, time-varying), T&D, EUI, factor provenance. |
| `POST /api/assets/<id>/intensity` | Backfill half-hourly regional grid intensity for a date range. |
| `pnpm carbon:intensity` | Same backfill for every asset over its stored readings' span. |

## Screening

`SCREENING_PROFILE` in `src/lib/assets/screening.ts` lists the point-based operations that run from an asset's coordinates or postcode: postcodes.io, EPC search (UPRN or postcode), EA flood warnings, NaFRA2 long-term flood risk, EA environmental constraints, Coal Authority, BGS geology, EA public registers, Historic England NHLE, Planning Data constraints, Natural England designations, DEFRA UK-AIR stations, and the current regional grid intensity.

Each result is stored with its status: **ok** (rows), **empty** (checked, nothing found), **partial** (no rows but the source reported problems with some layers, so absence is not established), **error** (upstream failed; message kept), **skipped** (asset lacks coordinates or postcode), **not configured** (key missing). Empty, partial and error are different things, and the page shows them differently. A screening is a desktop check, not a survey or a flood risk assessment; every source's own warnings are carried through.

## Carbon

Calculations in `src/lib/carbon/` use only versioned reference files, never hard-coded factors:

| Figure | Method | Factor source |
|---|---|---|
| Scope 1 | gas kWh (gross CV as metered) × natural gas factor | DESNZ flat file for the reporting year (`data/reference/desnz-conversion-factors/<year>.csv`) |
| Scope 2 location-based | electricity import kWh × UK electricity generated factor | DESNZ, same file |
| Scope 3 category 3 | electricity import kWh × T&D factor | DESNZ, same file |
| Scope 2 market-based | per meter: supplier factor with evidence if recorded, else residual mix | meter record; AIB residual mix file (`data/reference/aib-residual-mix/residual-mix.csv`), latest earlier data year if the reporting year is not published |
| Time-varying (operational only) | Σ half-hour kWh × regional grid intensity | `grid_intensity` table filled from the NESO Carbon Intensity API by postcode outward code |

Rules: an unavailable factor gives a null total with the reason in warnings, never zero; every line carries the factor's source, reference (publication, year, row id, file) and basis; a supplier factor without an evidence reference is flagged, because the GHG Protocol Scope 2 quality criteria require contractual evidence; partial years are flagged by counting days with data against the days in the year; a year with no readings says so. The time-varying figure is for load-shifting and PV self-consumption analysis and is not a reporting figure.

EUI is import kWh (electricity plus gas) divided by floor area, for the calendar year.

## What is still to do

- Multiple assets per meter with allocation shares (currently a meter counts in full on each asset it is linked to).
- Fiscal-year and rolling-12-month periods.
- Water and waste per asset.
- Persisting screening rows to the spatial layers the roadmap describes rather than calling each service per screening.
