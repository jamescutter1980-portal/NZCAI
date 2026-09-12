/** Small date helpers shared by connectors that must chunk or cap date ranges. No timezone maths beyond UTC. */

const DAY_MS = 86_400_000;

export function parseDate(iso: string): Date {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date ${iso}`);
  return d;
}

export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return toDateString(new Date(parseDate(iso).getTime() + n * DAY_MS));
}

/** Inclusive number of days from `from` to `to`. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS) + 1;
}

/** Throws before any network call if the range is reversed or longer than allowed. */
export function assertRange(from: string, to: string, maxDays: number, label = "range"): void {
  const days = daysInclusive(from, to);
  if (days < 1) throw new Error(`${label}: 'to' (${to}) is before 'from' (${from})`);
  if (days > maxDays) throw new Error(`${label}: ${days} days requested; maximum is ${maxDays} days per request`);
}

/** Splits an inclusive day range into consecutive chunks of at most `maxDays` days. */
export function chunkDays(from: string, to: string, maxDays: number): { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = [];
  let start = from;
  while (parseDate(start).getTime() <= parseDate(to).getTime()) {
    const end = addDays(start, maxDays - 1);
    const chunkEnd = parseDate(end).getTime() > parseDate(to).getTime() ? to : end;
    chunks.push({ from: start, to: chunkEnd });
    start = addDays(chunkEnd, 1);
  }
  return chunks;
}

/** "2026-09-09T12:00Z" style timestamp, minute precision, UTC. */
export function toIsoMinute(d: Date): string {
  return d.toISOString().slice(0, 16) + "Z";
}

/** Rounds down to the start of the current half hour (UTC). */
export function floorToHalfHour(d: Date): Date {
  const t = d.getTime();
  return new Date(t - (t % (30 * 60_000)));
}

export function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
