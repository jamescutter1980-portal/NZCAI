/**
 * Gap detection over half-hourly readings. A gap is a run of expected interval
 * starts with no reading, between the first and last expected interval.
 */
export interface Gap {
  from: string;
  to: string;
  missingIntervals: number;
}

export function findGaps(
  presentIntervalStarts: Iterable<string>,
  expectedFrom: string,
  expectedTo: string,
  intervalMs = 30 * 60_000,
): Gap[] {
  const present = new Set([...presentIntervalStarts].map((s) => new Date(s).getTime()));
  const start = new Date(expectedFrom).getTime();
  const end = new Date(expectedTo).getTime();
  const gaps: Gap[] = [];
  let gapStart: number | null = null;
  let missing = 0;
  for (let t = start; t < end; t += intervalMs) {
    if (present.has(t)) {
      if (gapStart !== null) {
        gaps.push({ from: new Date(gapStart).toISOString(), to: new Date(t).toISOString(), missingIntervals: missing });
        gapStart = null;
        missing = 0;
      }
    } else {
      if (gapStart === null) gapStart = t;
      missing += 1;
    }
  }
  if (gapStart !== null) {
    gaps.push({ from: new Date(gapStart).toISOString(), to: new Date(end).toISOString(), missingIntervals: missing });
  }
  return gaps;
}

export function summariseGaps(gaps: Gap[]): { count: number; missingIntervals: number } {
  return { count: gaps.length, missingIntervals: gaps.reduce((n, g) => n + g.missingIntervals, 0) };
}
