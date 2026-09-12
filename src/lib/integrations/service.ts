import { z } from "zod";
import {
  checkConfigured,
  defaultContext,
  paramsToSchema,
  type EnvLike,
  type HealthResult,
  type IntegrationDefinition,
  type OperationContext,
  type OperationResult,
} from "./framework";
import { getIntegration, integrations } from "./registry";

/** Serialisable view of a definition for the UI (no functions). */
export function describeIntegration(def: IntegrationDefinition, env: EnvLike = process.env) {
  const cfg = checkConfigured(def, env);
  return {
    id: def.id,
    name: def.name,
    group: def.group,
    access: def.access,
    territory: def.territory,
    description: def.description,
    docsUrl: def.docsUrl,
    termsUrl: def.termsUrl,
    attribution: def.attribution,
    licence: def.licence,
    status: def.status,
    notes: def.notes ?? [],
    envVars: def.envVars.map((v) => ({ ...v, set: Boolean(env[v.name]?.trim()) })),
    configured: cfg.configured,
    missing: cfg.missing,
    hasHealthCheck: Boolean(def.healthCheck),
    operations: def.operations.map((o) => ({ id: o.id, label: o.label, description: o.description, params: o.params })),
  };
}

export function listIntegrations(env: EnvLike = process.env) {
  return integrations.map((d) => describeIntegration(d, env));
}

export class SourceNotFoundError extends Error {}
export class OperationNotFoundError extends Error {}
export class NotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing configuration: ${missing.join(", ")}`);
  }
}
export class ParamValidationError extends Error {
  constructor(public readonly issues: z.core.$ZodIssue[]) {
    super("Invalid parameters");
  }
}

export async function runHealth(id: string, ctx: OperationContext = defaultContext()): Promise<HealthResult & { configured: boolean; missing: string[] }> {
  const def = getIntegration(id);
  if (!def) throw new SourceNotFoundError(id);
  const cfg = checkConfigured(def, ctx.env);
  if (!cfg.configured) return { ok: false, detail: `Not configured: set ${cfg.missing.join(", ")}`, ...cfg };
  if (!def.healthCheck) return { ok: true, detail: "No health check defined for this source", ...cfg };
  return { ...(await def.healthCheck(ctx)), ...cfg };
}

export async function runSourceOperation(id: string, opId: string, params: Record<string, unknown>, ctx: OperationContext = defaultContext()): Promise<OperationResult> {
  const def = getIntegration(id);
  if (!def) throw new SourceNotFoundError(id);
  const op = def.operations.find((o) => o.id === opId);
  if (!op) throw new OperationNotFoundError(opId);
  const cfg = checkConfigured(def, ctx.env);
  if (!cfg.configured) throw new NotConfiguredError(cfg.missing);
  const parsed = paramsToSchema(op.params).safeParse(params);
  if (!parsed.success) throw new ParamValidationError(parsed.error.issues);
  return op.run(parsed.data, ctx);
}
