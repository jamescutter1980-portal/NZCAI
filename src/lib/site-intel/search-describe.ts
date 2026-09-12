/**
 * The one-line summary of a search, and the type it needs.
 *
 * This is a leaf module on purpose: `search-run.ts` imports the database, so
 * anything that only needs to *describe* a run - the API's `description`
 * string, the UI, a narrative writer - can take it from here without pulling a
 * connection pool in behind it. Same reason `area-basis.ts` exists.
 *
 * `describeRun` is the parse-layer description plus the execution-layer
 * omissions. Without it a caller reading only `description` sees "Searching
 * for: ...; Not in a conservation area" and has no way to know that clause
 * never narrowed anything - the same failure `unparsed` guards against at the
 * layer above.
 */

export interface NotApplied {
  clause: string;
  reason: string;
}

export function describeRun(description: string, notApplied: NotApplied[]): string {
  if (!notApplied.length) return description;
  return (
    `${description} These parts were understood but could NOT be applied: ` +
    `${notApplied.map((n) => n.clause).join("; ")}. ` +
    "Results are therefore wider than the question asked."
  );
}
