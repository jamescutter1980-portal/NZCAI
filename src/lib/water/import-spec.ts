import { dateField, enumField, numberField, textField, type ImportSpec } from "@/lib/import";
import { WATER_BASES, WATER_SOURCES } from "./types";

/**
 * CSV import for water bill schedules and retailer export files.
 * Volumes may be litres or m³; the API converts to m³ via `toM3` when unit is set.
 */
export const waterConsumptionImportSpec: ImportSpec = {
  id: "water-consumption",
  label: "Water consumption",
  description:
    "Map columns from a water bill schedule, retailer portal export or MOSL/CMOS file. UK day-first dates are understood.",
  fields: [
    {
      name: "spid",
      label: "SPID / meter ref",
      required: true,
      aliases: ["spid", "supply point", "supply_point", "meter", "meter ref", "meter_ref", "account"],
      example: "3012345678",
      parse: textField({ maxLength: 20, upper: true }),
    },
    {
      name: "periodStart",
      label: "Period start",
      required: true,
      aliases: ["period start", "start", "from", "read from", "bill from"],
      example: "2025-04-01",
      parse: dateField(),
    },
    {
      name: "periodEnd",
      label: "Period end",
      required: true,
      aliases: ["period end", "end", "to", "read to", "bill to"],
      example: "2025-06-30",
      parse: dateField(),
    },
    {
      name: "volume",
      label: "Volume",
      required: true,
      aliases: ["volume", "consumption", "usage", "m3", "m³", "litres", "liters", "quantity"],
      example: "125.5",
      parse: numberField({ min: 0 }),
    },
    {
      name: "unit",
      label: "Unit",
      required: false,
      aliases: ["unit", "units", "uom"],
      help: "m3 or litres. Defaults to m3 when blank.",
      example: "m3",
      parse: textField({ maxLength: 20 }),
    },
    {
      name: "basis",
      label: "Basis",
      required: false,
      aliases: ["basis", "data quality"],
      help: "measured, estimated or client_declared",
      example: "client_declared",
      parse: enumField(WATER_BASES, {
        aliases: { actual: "measured", invoiced: "measured", meter: "measured", est: "estimated", estimate: "estimated", declared: "client_declared" },
      }),
    },
    {
      name: "source",
      label: "Source",
      required: false,
      aliases: ["source", "origin"],
      help: "bill, retailer_portal, mosl_cmos, amr_meter, manual or benchmark",
      example: "bill",
      parse: enumField(WATER_SOURCES, {
        aliases: { invoice: "bill", portal: "retailer_portal", retailer: "retailer_portal", cmos: "mosl_cmos", mosl: "mosl_cmos", amr: "amr_meter", smart: "amr_meter" },
      }),
    },
    {
      name: "evidence",
      label: "Evidence",
      required: false,
      aliases: ["evidence", "invoice", "bill ref", "reference"],
      example: "Wave invoice 2025-Q2",
      parse: textField({ maxLength: 300 }),
    },
    {
      name: "unitCostGbpPerM3",
      label: "Unit cost (£/m³)",
      required: false,
      aliases: ["unit cost", "£/m3", "gbp/m3", "rate"],
      example: "1.85",
      parse: numberField({ min: 0 }),
    },
    {
      name: "notes",
      label: "Notes",
      required: false,
      aliases: ["notes", "comment", "comments"],
      parse: textField({ maxLength: 1000 }),
    },
  ],
  rowCheck(row, rowNumber) {
    const start = row.periodStart as string | undefined;
    const end = row.periodEnd as string | undefined;
    if (start && end && end < start) return [`Row ${rowNumber}: Period end (${end}) is before period start (${start}).`];
    return [];
  },
};

export function normaliseBasis(raw?: string): (typeof WATER_BASES)[number] {
  const v = (raw ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if ((WATER_BASES as readonly string[]).includes(v)) return v as (typeof WATER_BASES)[number];
  if (v.includes("measure") || v.includes("meter")) return "measured";
  if (v.includes("estim") || v.includes("benchmark")) return "estimated";
  return "client_declared";
}

export function normaliseSource(raw?: string): (typeof WATER_SOURCES)[number] {
  const v = (raw ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if ((WATER_SOURCES as readonly string[]).includes(v)) return v as (typeof WATER_SOURCES)[number];
  if (v.includes("bill") || v.includes("invoice")) return "bill";
  if (v.includes("retailer") || v.includes("portal")) return "retailer_portal";
  if (v.includes("mosl") || v.includes("cmos")) return "mosl_cmos";
  if (v.includes("amr") || v.includes("smart")) return "amr_meter";
  if (v.includes("benchmark")) return "benchmark";
  return "manual";
}
