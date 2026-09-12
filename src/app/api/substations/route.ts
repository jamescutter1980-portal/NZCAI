import { NextResponse } from "next/server";
import { findSubstations } from "@/lib/substations";

export const dynamic = "force-dynamic";

function parseBbox(raw: string | null): [number, number, number, number] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts as [number, number, number, number];
}

function parseNumber(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;

  try {
    const { substations, containsSampleData } = await findSubstations({
      bbox: parseBbox(params.get("bbox")),
      minGenerationHeadroomMva: parseNumber(params.get("minGenerationHeadroomMva")),
      minVoltageKv: parseNumber(params.get("minVoltageKv")),
      limit: parseNumber(params.get("limit")),
    });

    return NextResponse.json({
      substations,
      count: substations.length,
      containsSampleData,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Query failed";
    return NextResponse.json(
      { error: message, substations: [], count: 0, containsSampleData: false },
      { status: 500 },
    );
  }
}
