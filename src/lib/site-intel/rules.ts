import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Loader for constraint_rules.yaml.
 *
 * Brief section 4.4: code returns states and rule keys only; all user-facing
 * wording lives here and is signed off by James. Nothing in this file or the
 * YAML states a legal conclusion - entries say what was found and what to go
 * and check.
 */

export interface ConstraintRule {
  label: string;
  present: string;
  proximity: string;
  check: string;
  /** NZC AI workstreams that should react to this constraint. */
  feeds: string[];
  /** False until James has signed the wording off. */
  approved: boolean;
}

interface RulesFile {
  rules: Record<string, ConstraintRule>;
}

let cache: Record<string, ConstraintRule> | null = null;

export function loadRules(): Record<string, ConstraintRule> {
  if (cache) return cache;
  const path = join(process.cwd(), "src", "lib", "site-intel", "constraint_rules.yaml");
  const parsed = parse(readFileSync(path, "utf8")) as RulesFile;
  if (!parsed?.rules) throw new Error("constraint_rules.yaml: missing top-level `rules` map");
  cache = parsed.rules;
  return cache;
}

export function getRule(dataset: string): ConstraintRule | null {
  return loadRules()[dataset] ?? null;
}

/** Every dataset that has wording. This is the screening set. */
export function ruleDatasets(): string[] {
  return Object.keys(loadRules());
}

/** Rule keys whose wording James has not signed off yet. */
export function unapprovedRules(): string[] {
  return Object.entries(loadRules())
    .filter(([, rule]) => !rule.approved)
    .map(([key]) => key);
}

/** Collapses YAML block-scalar whitespace and substitutes {buffer}. */
export function renderWording(text: string, bufferM: number): string {
  return text.replaceAll("{buffer}", String(bufferM)).replace(/\s+/g, " ").trim();
}
