import { NextResponse } from "next/server";
import { GROUP_LABELS } from "@/lib/integrations/framework";
import { listIntegrations } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ groups: GROUP_LABELS, sources: listIntegrations() });
}
