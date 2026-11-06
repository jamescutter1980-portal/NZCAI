# UK NZCBS reference tables, v1r1

**Standard:** UK Net Zero Carbon Buildings Standard, Version 1, Rev 1 (April 2026).
**Source of the figures:** Submission Proforma v1 rev03 (April 2026), the Excel workbook NZCBS Ltd publishes at https://www.nzcbuildings.co.uk/. The proforma's limit sheets were extracted to CSV and converted into these files by `scripts/nzcbs/convert-proforma-tables.py`.
**Publisher and copyright:** Net Zero Carbon Buildings Standard Ltd. Every result that uses these tables carries that attribution and the reminder to verify against the current publication.

Do not edit these files by hand. `manifest.json` holds a SHA-256 per file and both loaders (the portal's and the MCP layer's) refuse a file that does not match. A new revision of the Standard is a new folder, never an edit to this one.

## Files

| File | Rows | Contents |
|---|---|---|
| `limits.csv` | one per table, sector, subsector, scope, area basis and year | Tables EC-1, EC-2, EC-3 (upfront carbon), OE-1, OE-2, OE-3 (energy use intensity, GIA and the Offices NIA alternatives) and OE-4 (space heating) for Date of Commencement years 2025 to 2050 |
| `renewables_targets.csv` | 6 | Annex A3 on-site renewable electricity targets by region and building group |
| `other_limits.csv` | 3 | Annex A4 refrigerant GWP limit; Table EC-5 PV upfront carbon limit (Standard text and proforma figure, see below) |
| `reduction_curves.csv` | 26 | The residential and non-residential reduction curves printed beside Table EC-1 (informational) |
| `menus.csv` | 342 | Every controlled vocabulary in the proforma's menus sheet, for dropdowns and proforma population |

### `limits.csv` columns

`table, aspect, sector, subsector, scope, label, area_basis, year, value, unit, status, note`

- `sector` and `subsector` are spelled as the proforma spells them (doubled spaces collapsed). `label` is the proforma's column heading unchanged.
- `scope` is split from the label only where the suffix is one of the Standard's scopes: Whole building, Shell & Core + Cat A, Shell & Core only, Cat A + Cat B, Cat B, Landlord-only, Tenant-only.
- `status` is `limit` (a number in `value`), `no_limit` (the table says "no limit"), `not_applicable` ("n/a"), `deferred` ("As per NHS-NZ Standard") or `unavailable` (blank). None of these is ever a zero.
- Where the published table has one figure for a whole sector and the proforma shows it as a merged cell, every subsector carries that figure with the note "Sector-level limit; merged cell in the published table". This applies to the embodied carbon tables only.

## Hand check against Annex A of the Standard's text (5 November 2026)

The Rev 1 text's Annex A was read from the `nzcbs-standard` skill's extract of the PDF and the following rows were compared with the converted file. Every value matched.

| Table | Row checked | Values |
|---|---|---|
| EC-1 | 2025, all 18 columns | 580, 855, 570, 745, 790, 640, 430, 565, 670, 805, 595, 520, 715, 585, 755, 820, 635, 415 |
| EC-1 | 2044, all 18 columns | 120, 175, 120, 155, 165, 135, 80, 105, 140, 160, 120, 105, 150, 130, 155, 170, 130, 85 |
| EC-3 | 2025, 2030, 2050 | Offices Cat A+B 285 / 210 / 25; Offices Cat B 210 / 155 / 15; Storage Cat A+B 220 / 165 / 20; all other sectors "to be confirmed" |
| OE-1 | 2025, all columns | 75, 150, 80, 60, 5, 1.40, 1.20, NHS x5, 100, 50, 50, 125, 90, 113, 54, 68, 45, 135, 169, 155, 194, 200, 80, 215, 380, 55, 80, 50, 45, 60, 305, 80, 350, 150, 40, 90, 175 |
| OE-2 | 2025, all columns | 110, 220, 130, 100, 10, 1.40, 1.20, 258, 140, 162, 166, 182, 130, 80, 75, 180, 105, 131, 63, 79, 52, 200, 250, 230, 288, 230, 100, 250, 450, 80, 100, 90, 85, 95, 360, 210, 500, 280, 40, 115, 250 |
| OE-3 | 2025, all columns | 135, 290, 165, 125, 20, 1.40, 1.20, 293, 159, 185, 189, 206, 160, 100, 95, 220, 125, 156, 75, 94, 62, 220, 275, 245, 306, 410, 130, 310, 510, 100, 155, 120, 110, 110, 560, 300, 650, 400, 80, 175, 335 |
| OE-4 | 2025 onwards | Single Family 20; Flats 15; Commercial Residential 15; every other sector no limit |
| A3 | all | Scotland 30 / 60; Middle and North England, NI, Wales 40 / 65; South England 45 / 75 |
| A4 | | 677 kgCO2e/kg |

Not yet checked by hand: every year between 2026 and 2043 and 2045 to 2050 in the EC and OE tables. The converter copied them from the proforma unchanged. Checking them against the PDF is the remaining item of the verification log.

## Discrepancies and interpretation notes

1. **PV upfront carbon limit (Table EC-5).** The Rev 1 text prints **1000 kgCO2e/kWp**; the proforma's "Other limits" sheet prints **750**. Both are recorded in `other_limits.csv`. The engine uses the Standard's figure and prints the difference on every PV finding. Confirm with NZCBS Ltd before a submission relies on the margin between the two.
2. **Renewables target groups (Annex A3).** The text gives the higher target to "Single Family Homes, and single-storey Storage and Distribution". The proforma lists all three Storage and Distribution subsectors under the higher figure without the single-storey qualification. The files follow the text: `single_family_homes_or_single_storey_storage`.
3. **Healthcare in OE-1.** New Healthcare buildings defer to the NHS Net Zero Building Standard (`deferred`), while OE-2 and OE-3 publish numeric limits for them. The proforma's unit row says "n/a" for those columns; the unit kWh/m2GIA/yr is taken from Table 10 and noted on each row.
4. **NIA alternatives.** Only Offices have NIA-basis limits in the extracted tables. The proforma sheet carries stray "Schools" and "Sport and Leisure" headings over empty columns; nothing was read from them.
5. **Reportable Works, Storage.** The proforma's Storage column for Table EC-3 is headed "Cat A+B" with no subsector; it is stored as sector-level with scope "Cat A + Cat B", and the two whole-building subsector columns that inherit it carry the same scope.
6. **Publication date of Version 1.** The engine treats 1 March 2026 as the date before which works are assessed but not compared with limits (5.1.6) and refrigerant systems may use the 5.9.6 exception. The month is published; confirm the day against the Standard's front matter.
