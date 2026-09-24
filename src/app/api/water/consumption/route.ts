import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import {
  consumptionCreateSchema,
  SupplyPointNotFoundError,
  toM3,
  WaterRepository,
} from "@/lib/water";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  supplyPointId: z.string().max(64).optional(),
  assetId: z.string().max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const batchSchema = z.object({ rows: z.array(z.unknown()).min(1).max(20_000) });

/** Import row that may carry volume+unit instead of volumeM3, and SPID instead of supplyPointId. */
const importRowSchema = z
  .object({
    supplyPointId: z.string().min(1).max(64).optional(),
    spid: z.string().min(1).max(20).optional(),
    periodStart: z.string(),
    periodEnd: z.string(),
    volumeM3: z.number().nonnegative().optional(),
    volume: z.number().nonnegative().optional(),
    unit: z.string().max(40).optional(),
    basis: z.string().optional(),
    source: z.string().optional(),
    evidence: z.string().optional(),
    unitCostGbpPerM3: z.number().nonnegative().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

export async function GET(req: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  const readings = new WaterRepository(getDb()).listConsumption(parsed.data);
  const totalM3 = Math.round(readings.reduce((n, r) => n + r.volumeM3, 0) * 1000) / 1000;
  return NextResponse.json({ count: readings.length, totalM3, readings });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const repo = new WaterRepository(getDb());
  const batch = batchSchema.safeParse(body);
  if (batch.success) {
    const prepared: z.infer<typeof consumptionCreateSchema>[] = [];
    const issues: { row: number; message: string }[] = [];
    batch.data.rows.forEach((raw, i) => {
      const resolved = resolveRow(repo, raw);
      if (!resolved.ok) {
        issues.push({ row: i + 1, message: resolved.message });
        return;
      }
      const parsed = consumptionCreateSchema.safeParse(resolved.value);
      if (!parsed.success) {
        issues.push({ row: i + 1, message: parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
      } else {
        prepared.push(parsed.data);
      }
    });
    if (issues.length > 0) {
      return NextResponse.json(
        { error: `${issues.length} of ${batch.data.rows.length} rows are invalid; nothing was imported.`, issues: issues.slice(0, 50) },
        { status: 400 },
      );
    }
    try {
      const created = repo.createConsumptionBatch(prepared);
      return NextResponse.json({ created: created.length, readings: created }, { status: 201 });
    } catch (e) {
      if (e instanceof SupplyPointNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
      throw e;
    }
  }

  const resolved = resolveRow(repo, body);
  if (!resolved.ok) return NextResponse.json({ error: resolved.message }, { status: 400 });
  const one = consumptionCreateSchema.safeParse(resolved.value);
  if (!one.success) return NextResponse.json({ error: "Invalid consumption", issues: one.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ reading: repo.createConsumption(one.data) }, { status: 201 });
  } catch (e) {
    if (e instanceof SupplyPointNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}

function resolveRow(repo: WaterRepository, raw: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const parsed = importRowSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") };
  }
  const row = parsed.data;
  let supplyPointId = row.supplyPointId;
  if (!supplyPointId && row.spid) {
    const sp = repo.getSupplyPointBySpid(row.spid);
    if (!sp) return { ok: false, message: `No supply point registered for SPID ${row.spid.toUpperCase()}` };
    supplyPointId = sp.id;
  }
  if (!supplyPointId) return { ok: false, message: "supplyPointId or spid is required" };

  let volumeM3 = row.volumeM3;
  if (volumeM3 === undefined) {
    if (row.volume === undefined) return { ok: false, message: "volumeM3 or volume is required" };
    const converted = toM3(row.volume, row.unit ?? "m3");
    if (converted === null) return { ok: false, message: `Unrecognised volume unit "${row.unit}"` };
    volumeM3 = converted;
  }

  return {
    ok: true,
    value: {
      supplyPointId,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      volumeM3,
      basis: row.basis ?? "client_declared",
      source: row.source ?? "manual",
      evidence: row.evidence,
      unitCostGbpPerM3: row.unitCostGbpPerM3,
      notes: row.notes,
    },
  };
}
