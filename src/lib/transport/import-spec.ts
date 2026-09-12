import { dateField, enumField, integerField, numberField, registrationField, textField, type ImportSpec } from "@/lib/import";
import { BASES, TRANSPORT_CATEGORIES, TRANSPORT_CATEGORY_IDS } from "./types";

/**
 * Import spec for transport activity, so a client's mileage or travel
 * spreadsheet can be mapped rather than retyped.
 *
 * A row may carry a vehicle registration instead of an internal id; the batch
 * endpoint resolves it against the fleet register and says so when it cannot.
 */
const categoryAliases: Record<string, string> = {
  fleet: "fleet_owned",
  ownfleet: "fleet_owned",
  companycar: "fleet_owned",
  van: "fleet_owned",
  greyfleet: "grey_fleet",
  ownvehicle: "grey_fleet",
  privatecar: "grey_fleet",
  staffmileage: "grey_fleet",
  air: "business_travel_air",
  flight: "business_travel_air",
  flights: "business_travel_air",
  rail: "business_travel_rail",
  train: "business_travel_rail",
  taxi: "business_travel_road",
  bus: "business_travel_road",
  hirecar: "business_travel_road",
  ferry: "business_travel_sea",
  sea: "business_travel_sea",
  hotel: "hotel_stay",
  accommodation: "hotel_stay",
  commute: "commuting",
  freight: "freight_upstream",
  wtt: "well_to_tank",
};

export const transportActivityImportSpec: ImportSpec = {
  id: "transport-activity",
  label: "Transport activity",
  description:
    "One row per activity: a period's mileage, a set of flights, a batch of hotel nights. Quantity and unit must match the conversion factor you pick; a row with no factor is stored and reports as unavailable until one is chosen.",
  fields: [
    {
      name: "category",
      label: "Category",
      required: true,
      aliases: ["type", "activity type", "travel type", "mode"],
      help: Object.entries(TRANSPORT_CATEGORIES).map(([id, m]) => `${id} (${m.label})`).join("; "),
      example: "grey_fleet",
      parse: enumField(TRANSPORT_CATEGORY_IDS, { aliases: categoryAliases as Record<string, (typeof TRANSPORT_CATEGORY_IDS)[number]> }),
    },
    { name: "label", label: "Description", required: true, aliases: ["description", "detail", "name", "journey", "employee"], example: "Q1 staff mileage claims", parse: textField({ maxLength: 200 }) },
    { name: "periodStart", label: "From", required: true, aliases: ["start", "start date", "date", "from date", "period start"], example: "2025-01-01", parse: dateField() },
    { name: "periodEnd", label: "To", required: true, aliases: ["end", "end date", "to date", "period end"], example: "2025-03-31", parse: dateField() },
    { name: "quantity", label: "Quantity", required: true, aliases: ["distance", "mileage", "miles", "km", "amount", "value", "nights", "litres"], example: "8000", parse: numberField({ min: 0 }) },
    { name: "unit", label: "Unit", required: true, aliases: ["units", "uom", "measure"], help: "Must match the factor's unit, or be miles or km where the factor is the other.", example: "miles", parse: textField({ maxLength: 40 }) },
    { name: "factorId", label: "DESNZ factor row id", aliases: ["factor", "factor id", "desnz id", "row id"], help: "The id from the DESNZ flat file. Leave blank to choose it in the portal afterwards.", example: "101", parse: textField({ maxLength: 40 }) },
    { name: "factorYear", label: "Factor year", aliases: ["year", "factor set", "desnz year"], help: "The reporting year of the factor file the row id came from.", example: "2025", parse: integerField({ min: 2000, max: 2100 }) },
    { name: "basis", label: "Basis", aliases: ["data basis", "quality", "source type"], help: "measured, estimated or client_declared", example: "client_declared", parse: enumField(BASES, { aliases: { actual: "measured", metered: "measured", est: "estimated", estimate: "estimated", declared: "client_declared", client: "client_declared" } }) },
    { name: "vehicleRegistration", label: "Vehicle registration", aliases: ["registration", "reg", "vrm", "vehicle", "number plate"], help: "Matched against the fleet register; a row whose registration is unknown is still imported, without a vehicle.", example: "AB12CDE", parse: registrationField() },
    { name: "evidence", label: "Evidence", aliases: ["reference", "source", "document"], example: "Expenses export March 2025", parse: textField({ maxLength: 300 }) },
    { name: "notes", label: "Notes", aliases: ["comment", "comments"], parse: textField({ maxLength: 1000 }) },
  ],
  rowCheck(row, rowNumber) {
    const issues: string[] = [];
    const start = row.periodStart as string | undefined;
    const end = row.periodEnd as string | undefined;
    if (start && end && end < start) issues.push(`Row ${rowNumber}: To (${end}) is before From (${start}).`);
    if (row.factorId !== undefined && row.factorYear === undefined) issues.push(`Row ${rowNumber}: a factor row id needs a factor year.`);
    if (row.factorYear !== undefined && row.factorId === undefined) issues.push(`Row ${rowNumber}: a factor year needs a factor row id.`);
    return issues;
  },
};

/** Presentational subset for the import component. */
export const transportActivityImportFields = transportActivityImportSpec.fields.map((f) => ({
  name: f.name,
  label: f.label,
  required: f.required,
  help: f.help,
  example: f.example,
  parse: f.parse,
}));
