import { NextResponse } from "next/server";
import { z } from "zod";
import { desnzRows } from "@/lib/carbon/factors";
import { defaultContext } from "@/lib/integrations/framework";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  q: z.string().max(200).optional(),
  level1: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Browses the loaded DESNZ flat file so an activity can point at a published
 * row. Only rows the user actually has are offered; nothing is hard-coded.
 */
export function GET(req: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  const { year, q, level1, limit } = parsed.data;
  const rows = desnzRows(defaultContext(), year);
  if (rows.length === 0) {
    return NextResponse.json({
      year,
      rows: [],
      levels: [],
      total: 0,
      detail: `No DESNZ ${year} flat file is loaded. Save it as ${year}.csv under data/reference/desnz-conversion-factors.`,
    });
  }
  const needle = q?.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (level1 && r.level1.toLowerCase() !== level1.toLowerCase()) return false;
    if (!needle) return true;
    return `${r.level1} ${r.level2} ${r.level3} ${r.level4} ${r.column_text} ${r.uom}`.toLowerCase().includes(needle);
  });
  return NextResponse.json({
    year,
    total: filtered.length,
    levels: [...new Set(rows.map((r) => r.level1))].filter(Boolean).sort(),
    rows: filtered.slice(0, limit).map((r) => ({
      id: r.id, scope: r.scope, level1: r.level1, level2: r.level2, level3: r.level3, level4: r.level4,
      columnText: r.column_text, uom: r.uom, ghgUnit: r.ghg_unit, factor: r.factor, availability: r.availability,
    })),
  });
}
