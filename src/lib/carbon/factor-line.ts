import type { OperationContext } from "@/lib/integrations/framework";
import { desnzRowById, type ResolvedFactor } from "./factors";
import { normaliseUnit, unitConversion } from "./units";

/**
 * Turns a quantity plus a chosen DESNZ row into an emissions figure, applying
 * the three checks every activity line gets: the factor must resolve, its unit
 * must match the quantity's (converting only where the conversion is exact),
 * and the row's published scope must match the category the line was filed
 * under. Each check reports rather than overrules, except the unit mismatch,
 * which refuses to guess. A line that cannot be calculated returns null with
 * the reason, never zero.
 */
export interface FactorLineInput {
  factorId?: string;
  factorYear?: number;
  quantity: number;
  unit: string;
  /** The reporting period's factor year, so a mismatch can be flagged. */
  periodFactorYear: number;
  /** "Scope 1" or "Scope 3" as the GHG Protocol category implies. */
  expectedScope?: string;
  /** Label used in the scope-mismatch warning, e.g. "Category 6 business travel". */
  categoryLabel?: string;
}

export interface FactorLineResult {
  factor: ResolvedFactor;
  factorUnit: string | null;
  convertedQuantity: number | null;
  conversionNote?: string;
  kgCo2e: number | null;
  warnings: string[];
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function resolveFactorLine(ctx: OperationContext, input: FactorLineInput): FactorLineResult {
  const warnings: string[] = [];

  if (!input.factorId || input.factorYear === undefined) {
    return {
      factor: {
        value: null, unit: "", basis: "unavailable", source: "desnz-conversion-factors",
        reference: "no factor chosen", detail: "No conversion factor has been chosen for this activity.",
      },
      factorUnit: null,
      convertedQuantity: null,
      kgCo2e: null,
      warnings,
    };
  }

  const { row, factor } = desnzRowById(ctx, input.factorYear, input.factorId);
  if (input.factorYear !== input.periodFactorYear) {
    warnings.push(`Uses the ${input.factorYear} factor set while the period reports against ${input.periodFactorYear}.`);
  }
  if (row && input.expectedScope && !row.scope.toLowerCase().startsWith(input.expectedScope.toLowerCase())) {
    warnings.push(`Filed under ${input.categoryLabel ?? input.expectedScope} but the chosen DESNZ row is published as ${row.scope}. Check the category or the factor.`);
  }
  if (factor.value === null) {
    if (factor.detail) warnings.push(factor.detail);
    return { factor, factorUnit: row ? row.uom : null, convertedQuantity: null, kgCo2e: null, warnings };
  }

  const factorUnit = row?.uom ?? "";
  const conversion = unitConversion(input.unit, factorUnit);
  if (conversion === null) {
    warnings.push(`Quantity is in ${input.unit} but the factor is per ${factorUnit}. Convert the quantity or choose a factor in ${input.unit}.`);
    return {
      factor: { ...factor, basis: "unavailable", detail: `Unit mismatch: ${input.unit} against a factor per ${factorUnit}.` },
      factorUnit,
      convertedQuantity: null,
      kgCo2e: null,
      warnings,
    };
  }

  const converted = round3(input.quantity * conversion);
  return {
    factor,
    factorUnit,
    convertedQuantity: converted,
    conversionNote: conversion === 1 ? undefined : `${input.quantity} ${input.unit} converted to ${converted} ${factorUnit} at ${conversion} ${factorUnit} per ${normaliseUnit(input.unit)}.`,
    kgCo2e: round3(converted * factor.value),
    warnings,
  };
}
