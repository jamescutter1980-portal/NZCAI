import type { AspectId, AspectResult, Finding, FindingStatus } from "./types";

/** Small helpers shared by the aspect modules. */

export const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

export function finding(f: Omit<Finding, "gap"> & { gap?: number | null }): Finding {
  const gap = f.gap !== undefined ? f.gap : f.kind === "pass_fail" && f.value !== null && f.limit !== null ? round(f.value - f.limit) : null;
  return { ...f, gap };
}

/** A pass-fail comparison where a value at or below the limit passes. */
export function compare(args: { id: string; section: string; metric: string; value: number | null; limit: number | null; unit: string; reason: string; basis?: string; missingValue?: string; missingLimit?: string }): Finding {
  const { value, limit } = args;
  if (limit === null) {
    return finding({ id: args.id, section: args.section, kind: "pass_fail", metric: args.metric, status: "not_assessable", value, limit: null, unit: args.unit, reason: args.missingLimit ?? "No limit could be selected.", basis: args.basis });
  }
  if (value === null) {
    return finding({ id: args.id, section: args.section, kind: "pass_fail", metric: args.metric, status: "not_assessable", value: null, limit, unit: args.unit, reason: args.missingValue ?? "No value could be computed.", basis: args.basis });
  }
  const gap = round(value - limit);
  return finding({ id: args.id, section: args.section, kind: "pass_fail", metric: args.metric, status: gap > 0 ? "fail" : "pass", value: round(value), limit, unit: args.unit, gap, reason: args.reason, basis: args.basis });
}

export function reported(args: { id: string; section: string; metric: string; value: number | null; unit: string; reason: string; basis?: string }): Finding {
  return finding({ id: args.id, section: args.section, kind: "reporting", metric: args.metric, status: args.value === null ? "not_assessable" : "reported", value: args.value === null ? null : round(args.value), limit: null, unit: args.unit, reason: args.reason, basis: args.basis });
}

export function requirement(args: { id: string; section: string; metric: string; met: boolean | null; reason: string }): Finding {
  return finding({ id: args.id, section: args.section, kind: "requirement", metric: args.metric, status: args.met === null ? "not_assessable" : args.met ? "pass" : "fail", value: null, limit: null, unit: "", reason: args.reason });
}

export function notApplicable(args: { id: string; section: string; metric: string; reason: string; kind?: Finding["kind"] }): Finding {
  return finding({ id: args.id, section: args.section, kind: args.kind ?? "pass_fail", metric: args.metric, status: "not_applicable", value: null, limit: null, unit: "", reason: args.reason });
}

const RANK: Record<FindingStatus, number> = { fail: 4, not_assessable: 3, pass: 2, reported: 1, not_applicable: 0 };

/** Worst status across the pass-fail and requirement findings; reporting findings do not fail an aspect. */
export function overall(findings: Finding[]): FindingStatus {
  const decisive = findings.filter((f) => f.kind !== "reporting");
  if (decisive.length === 0) {
    return findings.some((f) => f.status === "reported") ? "reported" : findings.some((f) => f.status === "not_assessable") ? "not_assessable" : "not_applicable";
  }
  return decisive.reduce<FindingStatus>((worst, f) => (RANK[f.status] > RANK[worst] ? f.status : worst), "not_applicable");
}

export function aspectResult(aspect: AspectId, section: string, title: string, findings: Finding[], warnings: string[] = []): AspectResult {
  return { aspect, section, title, status: overall(findings), findings, warnings: [...new Set(warnings)] };
}

export const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
