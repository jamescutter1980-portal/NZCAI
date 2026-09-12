import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/sqlite";
import { TransportRepository, vehicleCreateSchema } from "@/lib/transport";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ vehicles: new TransportRepository(getDb()).listVehicles() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = vehicleCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid vehicle", issues: parsed.error.issues }, { status: 400 });
  const repo = new TransportRepository(getDb());
  if (parsed.data.registration) {
    const existing = repo.findVehicleByRegistration(parsed.data.registration);
    if (existing) return NextResponse.json({ error: `${parsed.data.registration} is already on the fleet`, vehicle: existing }, { status: 409 });
  }
  return NextResponse.json({ vehicle: repo.createVehicle(parsed.data) }, { status: 201 });
}
