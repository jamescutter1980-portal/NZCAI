import type { FetchLike, IntegrationDefinition, OperationContext, OperationResult } from "./framework";
import { paramsToSchema } from "./framework";

/** Context for tests: injected fetch, fixed clock, env of your choosing. */
export function testContext(fetch: FetchLike, env: Record<string, string> = {}, now = new Date("2026-09-09T12:00:00Z")): OperationContext {
  return { fetch, env, now: () => now };
}

/** Validates params the way the API route does, then runs the operation. */
export async function runOperation(def: IntegrationDefinition, opId: string, params: Record<string, unknown>, ctx: OperationContext): Promise<OperationResult> {
  const op = def.operations.find((o) => o.id === opId);
  if (!op) throw new Error(`${def.id} has no operation ${opId}`);
  const parsed = paramsToSchema(op.params).parse(params);
  return op.run(parsed, ctx);
}

/** A fetch that routes by URL substring to canned responses. */
export function routedFetch(routes: { match: string | RegExp; status?: number; body: unknown; headers?: Record<string, string> }[]): FetchLike {
  return async (input) => {
    const route = routes.find((r) => (typeof r.match === "string" ? input.includes(r.match) : r.match.test(input)));
    if (!route) return new Response(`no fixture for ${input}`, { status: 599 });
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, { status: route.status ?? 200, headers: route.headers ?? { "content-type": "application/json" } });
  };
}
