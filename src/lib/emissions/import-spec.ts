import { dateField, enumField, integerField, numberField, textField, type ImportSpec } from "@/lib/import";
import { BASES, EMISSION_CATEGORIES, EMISSION_CATEGORY_IDS } from "./types";

const categoryAliases: Record<string, string> = {
  refrigerant: "refrigerant_topup",
  refrigerantgas: "refrigerant_topup",
  fgas: "refrigerant_topup",
  topup: "refrigerant_topup",
  water: "water_supply",
  watersupplied: "water_supply",
  mainswater: "water_supply",
  wastewater: "water_treatment",
  sewerage: "water_treatment",
  effluent: "water_treatment",
  landfill: "waste_landfill",
  generalwaste: "waste_landfill",
  recycling: "waste_recycling",
  drymixedrecycling: "waste_recycling",
  dmr: "waste_recycling",
  energyrecovery: "waste_combustion",
  efw: "waste_combustion",
  incineration: "waste_combustion",
  compost: "waste_composting",
  composting: "waste_composting",
  ad: "waste_anaerobic_digestion",
  reuse: "waste_reuse",
};

/** Import spec for refrigerant, water and waste rows from a client's schedule. */
export const siteActivityImportSpec: ImportSpec = {
  id: "site-activity",
  label: "Refrigerants, water and waste",
  description:
    "One row per entry: a refrigerant top-up, a water bill period, a waste collection total. Quantity and unit must match the conversion factor you pick; a row with no factor is stored and reports as unavailable until one is chosen.",
  fields: [
    {
      name: "category",
      label: "Category",
      required: true,
      aliases: ["type", "stream", "waste stream", "activity"],
      help: Object.entries(EMISSION_CATEGORIES).map(([id, m]) => `${id} (${m.label})`).join("; "),
      example: "waste_recycling",
      parse: enumField(EMISSION_CATEGORY_IDS, { aliases: categoryAliases }),
    },
    { name: "label", label: "Description", required: true, aliases: ["description", "detail", "name", "site"], example: "Q2 dry mixed recycling", parse: textField({ maxLength: 200 }) },
    { name: "periodStart", label: "From", required: true, aliases: ["start", "start date", "date", "period start"], example: "2025-04-01", parse: dateField() },
    { name: "periodEnd", label: "To", required: true, aliases: ["end", "end date", "period end"], example: "2025-06-30", parse: dateField() },
    { name: "quantity", label: "Quantity", required: true, aliases: ["amount", "volume", "weight", "tonnes", "kg", "m3", "value"], example: "7.5", parse: numberField({ min: 0 }) },
    { name: "unit", label: "Unit", required: true, aliases: ["units", "uom", "measure"], help: "tonnes, kg, m3 or litres. Waste must be a mass for the diversion rate to work.", example: "tonnes", parse: textField({ maxLength: 40 }) },
    { name: "refrigerantType", label: "Refrigerant", aliases: ["gas", "refrigerant gas", "f-gas"], help: "Refrigerant rows only, e.g. R410A.", example: "R410A", parse: textField({ maxLength: 40 }) },
    { name: "wasteMaterial", label: "Material", aliases: ["waste material", "waste type", "material"], help: "Waste rows only, e.g. mixed commercial, paper, WEEE.", example: "Mixed commercial", parse: textField({ maxLength: 80 }) },
    { name: "factorId", label: "DESNZ factor row id", aliases: ["factor", "factor id", "desnz id"], help: "Leave blank to choose it in the portal afterwards.", example: "204", parse: textField({ maxLength: 40 }) },
    { name: "factorYear", label: "Factor year", aliases: ["year", "factor set"], example: "2025", parse: integerField({ min: 2000, max: 2100 }) },
    { name: "basis", label: "Basis", aliases: ["data basis", "quality"], help: "measured, estimated or client_declared", example: "measured", parse: enumField(BASES, { aliases: { actual: "measured", invoiced: "measured", est: "estimated", estimate: "estimated", declared: "client_declared" } }) },
    { name: "evidence", label: "Evidence", aliases: ["reference", "source", "document", "invoice"], example: "Waste contractor Q2 report", parse: textField({ maxLength: 300 }) },
    { name: "notes", label: "Notes", aliases: ["comment", "comments"], parse: textField({ maxLength: 1000 }) },
  ],
  rowCheck(row, rowNumber) {
    const issues: string[] = [];
    const start = row.periodStart as string | undefined;
    const end = row.periodEnd as string | undefined;
    const category = row.category as string | undefined;
    if (start && end && end < start) issues.push(`Row ${rowNumber}: To (${end}) is before From (${start}).`);
    if (row.factorId !== undefined && row.factorYear === undefined) issues.push(`Row ${rowNumber}: a factor row id needs a factor year.`);
    if (category === "refrigerant_topup" && row.refrigerantType === undefined) {
      issues.push(`Row ${rowNumber}: a refrigerant row should name the gas, so the factor can be checked against it.`);
    }
    return issues;
  },
};

export const siteActivityImportFields = siteActivityImportSpec.fields.map((f) => ({
  name: f.name, label: f.label, required: f.required, help: f.help, example: f.example, parse: f.parse,
}));
