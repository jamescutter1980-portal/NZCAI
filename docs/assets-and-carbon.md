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

## Reporting periods

Every energy and carbon figure can be reported over a calendar year, a financial year (any start month, April by default) or a rolling twelve months. A period is a half-open UTC interval, so a reading on 1 January belongs to that year and not the one before.

A financial or rolling period reports against the DESNZ factor set for the year it **starts** in, the usual UK convention. The factor year is shown with every result and can be overridden with `factorYear` on the API, because the right choice depends on the disclosure basis.

## Shared meters and allocation

A meter can serve several assets. Each link carries a **share** above 0 and up to 1, and only that share of the metered energy, cost and carbon counts towards the asset. `meteredKwh` keeps the unallocated figure alongside the allocated `kwh`, so nothing is lost.

The portfolio page checks the shares for every shared meter and flags two mistakes: **over-allocated** (shares add up to more than 100%, so energy is double counted) and **under-allocated** (they add up to less, so some energy belongs to no asset). Neither is corrected automatically, because only the user knows which asset the remainder belongs to.

## Portfolio

`/portfolio` rolls the assets up for a period: energy, EUI, the four carbon lines, intensity per m², and data completeness as the percentage of elapsed period days with readings. Sorting is by any column.

A scope total is **blank rather than zero** whenever any asset in it could not be calculated, and the number of assets behind each total is always shown. Data-quality issues are grouped by kind, with over-allocation, missing factors and missing readings shown first because they change the numbers rather than just limiting them.

## Net zero alignment

`/assets/<id>` runs two assessments on demand.

**CRREM** resolves the decarbonisation pathway for the asset's country, property type, scenario and pathway type from the loaded CRREM file, then carries today's intensity forward with no modelled improvement to find the misalignment year. The chart shows both lines and marks the crossing. Cumulative excess emissions to the horizon are reported where the asset exceeds the pathway.

**UK NZCBS** compares the asset against the limits in the loaded NZCBS file for its sector and year. Only a metric that is clearly operational energy in kWh/m² is compared against the portal's EUI; every other metric in the file is carried through as not assessable with the reason, since the portal cannot yet compute embodied carbon or on-site renewables. It is an indicative check against a loaded limit table, not a verified assessment.

Both need their reference file in `data/reference/`; without it the result says so rather than guessing.

## Exports

CSV exports at `/api/exports/<kind>`: `readings`, `asset-carbon`, `portfolio-energy`, `portfolio-carbon`, `secr-summary` and `consents`. They open cleanly in Excel (UTF-8 BOM, formula-injection guarded) and carry provenance in columns rather than preamble rows.

Exports are **calendar-year only** for now; the pages hide the link when another period is selected rather than exporting the wrong window.

The SECR summary is deliberately incomplete and says so on its face: transport, business travel, refrigerants, non-metered fuels, water, waste and embodied carbon are each a labelled exclusion row, and the table ends with a row stating it is not a complete disclosure. It is a starting point for a return, not the return.

## Transport and business travel

`/transport` covers what meter data cannot: mobile combustion from own and leased vehicles, grey fleet, air, rail, road and sea travel, hotel stays, employee commuting, freight and well-to-tank. It is organisation-level, so it sits alongside the per-asset roll-up rather than inside it.

**Every line points at a published DESNZ row by its id in the flat file**, rather than at a number the portal carries. The factor picker only offers rows from the file you have loaded, so the portal can never present a factor it does not hold, and each line records which row, which year's file, and what the published value and unit were.

Three checks run on every line, and each reports rather than overrules:

- **Unit.** The activity's unit must match the factor's. Distance units convert between miles and kilometres with the conversion stated on the line; anything else, such as litres against a per-kilometre factor, is refused with an explanation instead of a guess.
- **Scope.** Each category maps to a GHG Protocol scope and category. If the chosen DESNZ row is published under a different scope, the line says so.
- **Period.** Activity is attributed by its start date. A row running past the end of the reporting period is counted whole, with a warning, rather than silently split.

A line with no usable factor reports null with the reason, and the category total it belongs to goes blank rather than partial.

### Vehicles

The fleet register holds registration, make, model, fuel, engine size and ownership. **Look up** fills those from DVLA and estimates annual distance from MOT odometer readings, ignoring readings that do not increase and saying so. Two caveats travel with the data and appear in the interface:

- MOT odometer distance cannot separate business from private use, so it is an upper bound for grey-fleet business mileage, never the business figure.
- The DVLA CO2 value is a type-approval laboratory figure. It classifies and compares vehicles; it is not a substitute for a DESNZ factor in a calculation.

### Effect on SECR

With transport recorded, the SECR summary now includes mobile combustion in Scope 1 and lists business travel and commuting under their GHG Protocol categories. The transport exclusion rows disappear once there is data to replace them.

Transport **energy** in kWh only appears where fuel was recorded in kWh. Distance-based lines give emissions but not energy, and the export says so on the row rather than leaving the reader to work it out. Converting distance to energy needs a calorific value the portal does not hold.
