import { NextResponse } from "next/server";
import {
  buildProspectList,
  cohortSpec,
  COHORTS,
  PROSPECT_LIMIT,
  type Cohort,
  type ProspectFilter,
} from "@/lib/site-intel/prospects";
import { BANDS, type Band } from "@/lib/site-intel/performance";

export const dynamic = "force-dynamic";

const COHORT_KEYS = new Set<string>(COHORTS.map((c) => c.key));

function list(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function numeric(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Turns the CSV cell into something a spreadsheet renders as text.
 *
 * The leading-character guard is not cosmetic: a cell beginning =, +, - or @ is
 * executed as a formula by Excel and Sheets, and these cells carry addresses
 * and free-text findings from an external register.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * GET /api/site-intel/prospects
 *
 *   ?cohort=below_minimum,expired   ?district=DN4   ?postcode=DN4+8DE
 *   ?band=F,G   ?min_area=1000   ?max_area=5000   ?gas=1
 *   ?limit=200  ?format=csv
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;

  const cohorts = list(params.get("cohort"));
  const unknownCohorts = cohorts.filter((c) => !COHORT_KEYS.has(c));
  if (unknownCohorts.length) {
    return NextResponse.json(
      {
        error: `Unknown cohort: ${unknownCohorts.join(", ")}`,
        cohorts: COHORTS.map((c) => c.key),
      },
      { status: 400 },
    );
  }

  const bands = list(params.get("band")).map((b) => b.toUpperCase());
  const unknownBands = bands.filter((b) => !(BANDS as readonly string[]).includes(b));
  if (unknownBands.length) {
    return NextResponse.json(
      { error: `Unknown band: ${unknownBands.join(", ")}`, bands: BANDS },
      { status: 400 },
    );
  }

  const gasParam = params.get("gas");
  const filter: ProspectFilter = {
    cohorts: cohorts.length ? (cohorts as Cohort[]) : undefined,
    districts: list(params.get("district")).map((d) => d.toUpperCase()),
    postcodes: list(params.get("postcode")).map((p) => p.toUpperCase()),
    bands: bands.length ? (bands as Band[]) : undefined,
    minAreaM2: numeric(params.get("min_area")),
    maxAreaM2: numeric(params.get("max_area")),
    gasOrLpg: gasParam === null ? undefined : gasParam === "1" || gasParam === "true",
    limit: Math.min(numeric(params.get("limit")) ?? PROSPECT_LIMIT, PROSPECT_LIMIT),
  };

  try {
    const result = await buildProspectList(filter);

    if (params.get("format") !== "csv") {
      return NextResponse.json(result);
    }

    /*
     * The export is the dangerous artefact: once a list is in a spreadsheet it
     * travels without the page around it. So the caveats go INTO the file as
     * visible rows, and every row carries its own status sentence and an
     * explicit exemption-unknown column - a row read on its own still says
     * what it is.
     */
    const lines: string[] = [];
    lines.push(csvCell("MEES PROSPECT LIST — SCREENING ONLY, NOT A COMPLIANCE DETERMINATION"));
    lines.push(csvCell(`Generated ${new Date().toISOString()}`));
    lines.push(csvCell(result.coverage.statement));
    for (const caveat of result.caveats) lines.push(csvCell(caveat));
    if (result.wordingUnapproved.length) {
      lines.push(
        csvCell(
          `Wording for ${result.wordingUnapproved.length} rule(s) has not been signed off. ` +
            "Do not issue this to a client until it has.",
        ),
      );
    }
    lines.push("");

    const columns = [
      "cohort", "cohort_criteria", "address", "postcode", "uprn", "band", "ber_score",
      "floor_area_m2", "main_fuel", "gas_or_lpg", "lodgement_date", "epc_expires",
      "days_remaining", "bands_to_minimum", "ber_points_to_minimum", "bands_to_2031_target",
      "ber_points_to_2031_target", "exemption_status_unknown", "finding", "flags", "lmk_key",
    ];
    lines.push(columns.map(csvCell).join(","));

    for (const p of result.prospects) {
      lines.push(
        [
          cohortSpec(p.cohort).label,
          cohortSpec(p.cohort).criteria,
          p.address, p.postcode, p.uprn, p.band, p.score,
          p.floorAreaM2, p.mainFuel, p.gasOrLpg ? "yes" : "no",
          p.lodgementDate, p.expiresOn, p.daysRemaining,
          p.bandsToMinimum, p.scorePointsToMinimum,
          p.bandsToTarget, p.scorePointsToTarget,
          "yes — the PRS Exemptions Register is not held",
          p.finding, p.flagKeys.join("; "), p.lmkKey,
        ].map(csvCell).join(","),
      );
    }

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mees-prospects-${stamp}.csv"`,
      },
    }) as NextResponse;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Prospect list failed" },
      { status: 500 },
    );
  }
}
