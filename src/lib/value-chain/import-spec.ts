import { dateField, enumField, integerField, numberField, textField, type ImportSpec } from "@/lib/import";
import { ACTIVITY_BASES, ASKS, ROLES, ROLE_IDS, SCOPE3_CATEGORY_IDS } from "./types";

/* ------------------------------------------------------------------ */
/* counterparty register                                               */
/* ------------------------------------------------------------------ */

const roleAliases: Record<string, string> = {
  vendor: "supplier",
  goods: "supplier",
  services: "supplier",
  contractor: "supplier",
  capex: "capital_supplier",
  capital: "capital_supplier",
  plant: "capital_supplier",
  energy: "energy_supplier",
  fuel: "energy_supplier",
  utility: "energy_supplier",
  electricity: "energy_supplier",
  gas: "energy_supplier",
  haulier: "logistics",
  haulage: "logistics",
  courier: "logistics",
  freight: "logistics",
  transport: "logistics",
  waste: "waste_contractor",
  wastecarrier: "waste_contractor",
  travel: "travel_provider",
  airline: "travel_provider",
  hotel: "travel_provider",
  lessor: "landlord",
  brand: "franchisor",
  licensor: "franchisor",
  outbound: "outbound_logistics",
  client: "customer",
  buyer: "customer",
  occupier: "tenant",
  concession: "tenant",
  lessee: "tenant",
  investment: "investee",
};

/** A list cell: "supplier; logistics" or "1,4". Split, then each item is checked against the allowed set. */
function listField<V extends string>(values: readonly V[], aliases: Record<string, V>, what: string) {
  const one = enumField(values, { aliases });
  return (raw: string) => {
    const items = raw.split(/[;,|/]/).map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) return { ok: false as const, error: "is blank" };
    const out: V[] = [];
    for (const item of items) {
      const r = one(item.replace(/^cat(egory)?\s*/i, ""), {});
      if (!r.ok) return { ok: false as const, error: `${what} ${r.error}` };
      if (!out.includes(r.value)) out.push(r.value);
    }
    return { ok: true as const, value: out };
  };
}

/** Import spec for the counterparty register: one row per supplier, customer, tenant or other counterparty. */
export const counterpartyImportSpec: ImportSpec = {
  id: "counterparties",
  label: "Value chain counterparties",
  description:
    "One row per counterparty. A row whose name matches an existing counterparty updates it; otherwise it is created. Roles and categories can hold several values separated by semicolons.",
  fields: [
    { name: "name", label: "Name", required: true, aliases: ["counterparty", "supplier", "supplier name", "company", "vendor", "customer"], example: "Bidfood Ltd", parse: textField({ maxLength: 200 }) },
    { name: "companyNumber", label: "Company number", aliases: ["companies house", "crn", "registration number"], example: "01234567", parse: textField({ maxLength: 20, upper: true }) },
    { name: "sector", label: "Sector", aliases: ["industry", "sic", "sic description", "category of spend"], example: "Food wholesale", parse: textField({ maxLength: 120 }) },
    { name: "country", label: "Country", aliases: ["country code"], help: "Two-letter ISO code.", example: "GB", parse: textField({ maxLength: 2, upper: true }) },
    {
      name: "roles",
      label: "Roles",
      required: true,
      aliases: ["role", "relationship", "type", "counterparty type"],
      help: Object.entries(ROLES).map(([id, m]) => `${id} (${m.label})`).join("; "),
      example: "supplier; distributor",
      parse: listField(ROLE_IDS, roleAliases, "role"),
    },
    {
      name: "ghgCategories",
      label: "Scope 3 categories",
      aliases: ["categories", "ghg categories", "scope 3 category", "category"],
      help: "Category numbers 1 to 15, separated by semicolons. Left blank, they follow from the roles.",
      example: "1; 4",
      parse: listField(SCOPE3_CATEGORY_IDS, {}, "category"),
    },
    { name: "annualValueGbp", label: "Annual value (£)", aliases: ["spend", "annual spend", "spend gbp", "revenue", "annual revenue", "value"], help: "Spend with an upstream counterparty, or revenue from a downstream one. Drives the ranking.", example: "1250000", parse: numberField({ min: 0 }) },
    { name: "contactName", label: "Contact name", aliases: ["contact", "account manager", "sustainability contact"], example: "A Patel", parse: textField({ maxLength: 120 }) },
    { name: "contactEmail", label: "Contact email", aliases: ["email", "contact email address"], example: "a.patel@example.com", parse: textField({ maxLength: 200 }) },
    { name: "escalationName", label: "Escalation contact", aliases: ["escalation", "senior contact", "commercial contact"], example: "J Smith", parse: textField({ maxLength: 120 }) },
    { name: "escalationEmail", label: "Escalation email", aliases: ["escalation email address", "senior contact email"], example: "j.smith@example.com", parse: textField({ maxLength: 200 }) },
    { name: "ask", label: "Ask", aliases: ["request type", "data requested", "minimum ask"], help: "annual_ghg_report (the default), activity_ledger or either.", example: "annual_ghg_report", parse: enumField(ASKS, { aliases: { report: "annual_ghg_report", ghgreport: "annual_ghg_report", ledger: "activity_ledger", activity: "activity_ledger", both: "either" } }) },
    { name: "status", label: "Status", aliases: ["active"], example: "active", parse: enumField(["active", "inactive"] as const, { aliases: { yes: "active", y: "active", live: "active", no: "inactive", n: "inactive", dormant: "inactive", closed: "inactive" } }) },
    { name: "notes", label: "Notes", aliases: ["comment", "comments"], parse: textField({ maxLength: 2000 }) },
  ],
};

export const counterpartyImportFields = counterpartyImportSpec.fields.map((f) => ({ name: f.name, label: f.label, required: f.required, help: f.help, example: f.example, parse: f.parse }));

/* ------------------------------------------------------------------ */
/* activity ledger from a counterparty                                 */
/* ------------------------------------------------------------------ */

/**
 * The template sent to a counterparty that has no annual GHG report. The
 * counterparty id and reporting year are supplied by the page the file is
 * uploaded on, so the counterparty never has to know them.
 */
export const activityLedgerImportSpec: ImportSpec = {
  id: "counterparty-activity",
  label: "Counterparty activity ledger",
  description:
    "One row per activity and period as the counterparty recorded it: energy in kWh, fuel in litres, transport in km or tonne-km, waste in tonnes. Share is the percentage of the line done on our account. A DESNZ factor row can be chosen afterwards in the portal.",
  fields: [
    { name: "label", label: "Description", required: true, aliases: ["description", "detail", "name", "site", "line"], example: "Depot electricity Q1", parse: textField({ maxLength: 200 }) },
    { name: "activityType", label: "Activity type", required: true, aliases: ["activity", "type", "fuel", "stream", "source"], help: "What the line is: electricity, natural gas, diesel, HGV tonne-km, waste to landfill.", example: "Electricity", parse: textField({ maxLength: 120 }) },
    { name: "periodStart", label: "From", required: true, aliases: ["start", "start date", "date", "period start"], example: "2025-01-01", parse: dateField() },
    { name: "periodEnd", label: "To", required: true, aliases: ["end", "end date", "period end"], example: "2025-03-31", parse: dateField() },
    { name: "quantity", label: "Quantity", required: true, aliases: ["amount", "value", "consumption", "volume", "distance", "weight", "kwh", "litres", "km", "tonnes"], example: "48200", parse: numberField({ min: 0 }) },
    { name: "unit", label: "Unit", required: true, aliases: ["units", "uom", "measure"], help: "kWh, litres, km, tonne.km, tonnes or kg, matching the factor chosen.", example: "kWh", parse: textField({ maxLength: 40 }) },
    { name: "sharePct", label: "Share (%)", aliases: ["share", "our share", "attributable %", "allocation", "allocation %"], help: "Percentage of the line attributable to us. Blank means 100.", example: "100", parse: numberField({ min: 0, max: 100 }) },
    { name: "declaredKgCo2e", label: "Declared kgCO2e", aliases: ["kgco2e", "kg co2e", "co2e", "emissions", "tco2e"], help: "The counterparty's own figure for the line, in kg, used only where no factor row is chosen.", example: "9980", parse: numberField({ min: 0 }) },
    { name: "factorId", label: "DESNZ factor row id", aliases: ["factor", "factor id", "desnz id"], help: "Leave blank to choose it in the portal afterwards.", example: "", parse: textField({ maxLength: 40 }) },
    { name: "factorYear", label: "Factor year", aliases: ["year", "factor set"], example: "", parse: integerField({ min: 2000, max: 2100 }) },
    { name: "basis", label: "Basis", aliases: ["data basis", "quality"], help: "measured, estimated or supplier_declared", example: "measured", parse: enumField(ACTIVITY_BASES, { aliases: { actual: "measured", metered: "measured", invoiced: "measured", est: "estimated", estimate: "estimated", declared: "supplier_declared", supplier: "supplier_declared" } }) },
    { name: "evidence", label: "Evidence", aliases: ["reference", "source document", "document", "invoice"], example: "Q1 utility bills", parse: textField({ maxLength: 300 }) },
    { name: "notes", label: "Notes", aliases: ["comment", "comments"], parse: textField({ maxLength: 1000 }) },
  ],
  rowCheck(row, rowNumber) {
    const issues: string[] = [];
    const start = row.periodStart as string | undefined;
    const end = row.periodEnd as string | undefined;
    if (start && end && end < start) issues.push(`Row ${rowNumber}: To (${end}) is before From (${start}).`);
    if (row.factorId !== undefined && row.factorYear === undefined) issues.push(`Row ${rowNumber}: a factor row id needs a factor year.`);
    return issues;
  },
};

export const activityLedgerImportFields = activityLedgerImportSpec.fields.map((f) => ({ name: f.name, label: f.label, required: f.required, help: f.help, example: f.example, parse: f.parse }));
