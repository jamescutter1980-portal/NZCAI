import { NextResponse } from "next/server";
import { describeN3rgyConfig } from "@/lib/integrations/n3rgy";

export const dynamic = "force-dynamic";

/** Reports whether the n3rgy connector is configured. Never returns the key. */
export function GET() {
  return NextResponse.json(describeN3rgyConfig());
}
