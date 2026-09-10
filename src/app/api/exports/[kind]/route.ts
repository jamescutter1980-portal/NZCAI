import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { defaultContext } from "@/lib/integrations/framework";
import { getConsentStore } from "@/lib/consent/registry";
import {
  buildAssetCarbonExport,
  buildConsentsExport,
  buildPortfolioCarbonExport,
  buildPortfolioEnergyExport,
  buildReadingsExport,
  buildSecrSummaryExport,
  exportHeaders,
  isExportKind,
  readingsParamsSchema,
  toCsv,
  type ExportKind,
  type ExportTable,
} from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * One route for every export kind. Each returns a single-table CSV as an
 * attachment. Missing reference data never throws here: an unavailable factor
 * becomes a blank cell with its reason in a column, which is the whole point
 * of the export layer.
 */

const yearSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
});

/** Excel on Windows needs the BOM to read UTF-8; default on, "0"/"false"/"no" turns it off. */
const bomSchema = z
  .preprocess((v) => (v === undefined || v === "" ? true : !/^(0|false|no)$/i.test(String(v))), z.boolean())
  .default(true);

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!isExportKind(kind)) {
    return NextResponse.json({ error: `Unknown export kind "${kind}"` }, { status: 404 });
  }
  const query = Object.fromEntries(new URL(req.url).searchParams);
  const bom = bomSchema.safeParse(query.bom);
  if (!bom.success) return invalid(bom.error);

  let built: Built;
  try {
    built = await build(kind, query);
  } catch (e) {
    // Absent reference data is handled inside the builders and never lands
    // here. A malformed reference file can, and a caller expecting a CSV
    // should get a readable reason rather than an HTML error page.
    return NextResponse.json({ error: "Export failed", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  if ("error" in built) return built.error;

  return respond(built.table, bom.data);
}

type Built = { table: ExportTable } | { error: NextResponse };

async function build(kind: ExportKind, query: Record<string, string>): Promise<Built> {
  const db = getDb();
  const ctx = defaultContext();

  if (kind === "readings") {
    const parsed = readingsParamsSchema.safeParse(query);
    if (!parsed.success) return { error: invalid(parsed.error) };
    if (parsed.data.end < parsed.data.start) {
      return { error: NextResponse.json({ error: "end must not be before start" }, { status: 400 }) };
    }
    return { table: buildReadingsExport(db, parsed.data) };
  }

  if (kind === "consents") {
    return { table: buildConsentsExport(await getConsentStore().list(), ctx.now()) };
  }

  if (kind === "asset-carbon") {
    const parsed = yearSchema.extend({ asset: z.string().min(1, "asset id is required") }).safeParse(query);
    if (!parsed.success) return { error: invalid(parsed.error) };
    const t = buildAssetCarbonExport(db, ctx, parsed.data.asset, parsed.data.year);
    if (!t) return { error: NextResponse.json({ error: `Asset ${parsed.data.asset} not found` }, { status: 404 }) };
    return { table: t };
  }

  const parsed = yearSchema.safeParse(query);
  if (!parsed.success) return { error: invalid(parsed.error) };
  const { year } = parsed.data;
  if (kind === "portfolio-energy") return { table: buildPortfolioEnergyExport(db, ctx, year) };
  if (kind === "portfolio-carbon") return { table: buildPortfolioCarbonExport(db, ctx, year) };
  return { table: buildSecrSummaryExport(db, ctx, year) };
}

function invalid(error: z.ZodError): NextResponse {
  return NextResponse.json({ error: "Invalid query", issues: error.issues }, { status: 400 });
}

function respond(table: ExportTable, bom: boolean): Response {
  return new Response(toCsv(table.columns, table.rows, { bom }), { headers: exportHeaders(table) });
}
