import { NextResponse } from "next/server";
import { z } from "zod";
import { listMembers, MOSL_MEMBERS_SOURCE, type MoslRole } from "@/lib/water";

export const dynamic = "force-dynamic";

const ROLES = ["wholesaler", "retailer", "nav", "self_supply", "third_party"] as const;

const querySchema = z.object({
  role: z.enum(ROLES).optional(),
  q: z.string().max(80).optional(),
});

/** MOSL trading parties from the published Our Members register. */
export async function GET(req: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query", issues: parsed.error.issues }, { status: 400 });
  const members = listMembers({ role: parsed.data.role as MoslRole | undefined, q: parsed.data.q });
  return NextResponse.json({
    source: MOSL_MEMBERS_SOURCE,
    count: members.length,
    members,
  });
}
