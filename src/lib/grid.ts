/**
 * Wording and freshness rules that travel with every grid figure.
 * Lives in lib/ rather than ingest/ so the client bundle does not pull in
 * ingestion code to render a caveat.
 */

/**
 * Fixed wording required on every grid output by the Site Intelligence brief
 * (S-03 section 5.4). Not editable in the UI - it travels with the figures.
 */
export function gridCaveat(dnoName: string, sourceDate: string | null): string {
  const date = sourceDate
    ? new Date(sourceDate).toLocaleDateString("en-GB")
    : "an unknown date";
  return `Indicative only — based on published DNO data dated ${date}. Not a connection offer. A connection application to ${dnoName} is required.`;
}

/** Brief section 5.4: data older than 90 days is stale and shown with a warning. */
export const STALE_AFTER_DAYS = 90;

export function isStale(ingestedAt: string): boolean {
  const ageMs = Date.now() - new Date(ingestedAt).getTime();
  return Number.isFinite(ageMs) && ageMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}
