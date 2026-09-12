/**
 * Date helpers for the n3rgy API, which uses YYYYMMDDHHmm in query strings and
 * returns timestamps as "YYYY-MM-DD HH:mm" (or YYYYMMDDHHmm) in UTC.
 */

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Formats a Date as YYYYMMDDHHmm in UTC. */
export function toN3rgyDateString(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  );
}

/**
 * Parses any n3rgy timestamp form to an ISO 8601 UTC string. Returns the input
 * unchanged if it does not match a known form, so unknown values are visible
 * rather than silently dropped.
 */
export function fromN3rgyTimestamp(s: string): string {
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/;
  const compactDate = /^(\d{4})(\d{2})(\d{2})$/;
  const dashed = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
  const dashedDate = /^(\d{4})-(\d{2})-(\d{2})$/;
  let m: RegExpMatchArray | null;
  if ((m = s.match(compact)) || (m = s.match(dashed))) {
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
  }
  if ((m = s.match(compactDate)) || (m = s.match(dashedDate))) {
    return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
  }
  return s;
}

export interface DateRange {
  start: Date;
  end: Date;
}

/** Whole calendar days covered by the range, inclusive of both ends. */
export function rangeDays({ start, end }: DateRange): number {
  const msPerDay = 86_400_000;
  const s = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const e = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.floor((e - s) / msPerDay) + 1;
}

/**
 * Splits a range into consecutive chunks of at most maxDays calendar days.
 * The API rejects requests longer than 90 days.
 */
export function chunkRange(range: DateRange, maxDays = 90): DateRange[] {
  if (range.end < range.start) {
    throw new RangeError("end must not be before start");
  }
  const total = rangeDays(range);
  if (total <= maxDays) return [range];
  const chunks: DateRange[] = [];
  let cursor = new Date(range.start);
  while (cursor < range.end) {
    const chunkEnd = new Date(cursor.getTime() + maxDays * 86_400_000);
    const end = chunkEnd < range.end ? chunkEnd : range.end;
    chunks.push({ start: cursor, end });
    cursor = new Date(end.getTime() + 60_000);
  }
  return chunks;
}
