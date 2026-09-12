import { NextResponse } from "next/server";
import { IntegrationHttpError } from "@/lib/integrations/framework";
import {
  NotConfiguredError,
  OperationNotFoundError,
  ParamValidationError,
  runSourceOperation,
  SourceNotFoundError,
} from "@/lib/integrations/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, { params }: { params: Promise<{ id: string; op: string }> }) {
  const { id, op } = await params;
  let body: Record<string, unknown> = {};
  const text = await req.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
    }
  }
  try {
    const result = await runSourceOperation(id, op, body);
    return NextResponse.json({ result });
  } catch (e) {
    if (e instanceof SourceNotFoundError) return NextResponse.json({ error: "Unknown source" }, { status: 404 });
    if (e instanceof OperationNotFoundError) return NextResponse.json({ error: "Unknown operation" }, { status: 404 });
    if (e instanceof NotConfiguredError) return NextResponse.json({ error: e.message, missing: e.missing }, { status: 503 });
    if (e instanceof ParamValidationError) return NextResponse.json({ error: "Invalid parameters", issues: e.issues }, { status: 400 });
    if (e instanceof IntegrationHttpError) {
      return NextResponse.json({ error: e.message, upstreamStatus: e.status, upstreamBody: e.body, url: e.url }, { status: 502 });
    }
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
      return NextResponse.json({ error: "Upstream timed out" }, { status: 504 });
    }
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
