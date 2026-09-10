import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import type { AssetMeter, AssetRecord } from "@/lib/assets/types";
import { crremAssessment, type CrremAssessment, type PathwayType, type Scenario } from "./crrem";
import { nzcbsAssessment, type NzcbsAssessment } from "./nzcbs";

/**
 * Assessment engine: what one asset's metered performance in one year means
 * against the CRREM decarbonisation pathways and the UK Net Zero Carbon
 * Buildings Standard limits the user has loaded.
 *
 * Both views are computed on demand from the readings and the reference
 * files; nothing is stored, so a corrected reading or a newer reference file
 * changes the next result. Missing reference data is always a result with a
 * reason, never an exception and never a zero.
 */

export * from "./crrem";
export * from "./nzcbs";

export interface AssessmentOptions {
  year: number;
  /** CRREM property type. Defaults to the asset's property type. */
  propertyType?: string;
  /** NZCBS sector. Defaults to the asset's property type. */
  sector?: string;
  /** CRREM country. Defaults to the asset's country, then GB. */
  country?: string;
  scenario?: Scenario;
  pathwayType?: PathwayType;
  /** CRREM file name without .csv. Defaults to the newest loaded version. */
  version?: string;
  /** NZCBS file name without .csv. Defaults to the newest loaded version. */
  nzcbsVersion?: string;
  /** Year the cumulative excess emissions are summed to. Defaults to 2050. */
  horizonYear?: number;
}

export interface AssetAssessment {
  crrem: CrremAssessment;
  nzcbs: NzcbsAssessment;
}

/** Both views for one asset and reporting year. */
export function assessAsset(db: Db, ctx: OperationContext, asset: AssetRecord, meters: AssetMeter[], opts: AssessmentOptions): AssetAssessment {
  return {
    crrem: crremAssessment(db, ctx, asset, meters, {
      year: opts.year,
      propertyType: opts.propertyType,
      country: opts.country,
      scenario: opts.scenario,
      version: opts.version,
      pathwayType: opts.pathwayType,
      horizonYear: opts.horizonYear,
    }),
    nzcbs: nzcbsAssessment(db, ctx, asset, meters, { year: opts.year, sector: opts.sector, version: opts.nzcbsVersion }),
  };
}
