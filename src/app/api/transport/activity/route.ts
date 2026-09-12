import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/sqlite";
import { activityCreateSchema, TransportRepository } from "@/lib/transport";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const repo = new TransportRepository(getDb());
  return NextResponse.json({
    activity: repo.listActivity({ from: p.get("from") ?? undefined, to: p.get("to") ?? undefined }),
  });
}

/**
 * An imported row may name a vehicle by registration rather than by id, so the
 * registration is resolved here and an unknown one is reported instead of
 * silently dropping the link.
 */
const importRowSchema = z.looseObject({ vehicleRegistration: z.string().optional() });
const batchSchema = z.object({ rows: z.array(z.unknown()).min(1).max(20_000) });

/** Accepts one activity or a batch from a CSV import. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const repo = new TransportRepository(getDb());
  const batch = batchSchema.safeParse(body);
  if (batch.success) {
    const warnings: string[] = [];
    const issues: { row: number; message: string }[] = [];
    const prepared: import("@/lib/transport").ActivityCreate[] = [];
    batch.data.rows.forEach((raw, i) => {
      const loose = importRowSchema.safeParse(raw);
      const { vehicleRegistration, ...rest } = loose.success ? loose.data : (raw as Record<string, unknown>);
      let vehicleId: string | undefined;
      if (typeof vehicleRegistration === "string" && vehicleRegistration.trim()) {
        const vehicle = repo.findVehicleByRegistration(vehicleRegistration);
        if (vehicle) vehicleId = vehicle.id;
        else warnings.push(`Row ${i + 1}: ${vehicleRegistration} is not on the fleet register, so the row was imported without a vehicle.`);
      }
      const parsed = activityCreateSchema.safeParse({ ...rest, ...(vehicleId ? { vehicleId } : {}) });
      if (!parsed.success) {
        issues.push({ row: i + 1, message: parsed.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
        return;
      }
      prepared.push(parsed.data);
    });
    if (issues.length > 0) {
      return NextResponse.json({ error: `${issues.length} of ${batch.data.rows.length} rows are invalid; nothing was imported.`, issues: issues.slice(0, 50) }, { status: 400 });
    }
    const created = repo.createActivityBatch(prepared);
    return NextResponse.json({ created: created.length, warnings, activity: created }, { status: 201 });
  }
  const one = activityCreateSchema.safeParse(body);
  if (!one.success) return NextResponse.json({ error: "Invalid activity", issues: one.error.issues }, { status: 400 });
  return NextResponse.json({ activity: repo.createActivity(one.data) }, { status: 201 });
}
