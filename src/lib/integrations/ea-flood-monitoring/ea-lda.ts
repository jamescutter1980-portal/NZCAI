/**
 * Small helpers for Environment Agency linked-data APIs on
 * environment.data.gov.uk. Every list endpoint returns
 * `{ "@context", meta: { limit, offset, ... }, items: [...] }`; literals may be
 * plain values or `{ "_value": "...", "_lang": "en" }`; resources appear as
 * URIs or `{ "@id", label/prefLabel/notation }`.
 */

export interface EaList<T> {
  "@context"?: string;
  meta?: Record<string, unknown>;
  items?: T[];
}

/** A plain string from a literal, a labelled resource, an array of either, or nothing. */
export function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(text).filter((s): s is string => !!s);
    return parts.length ? Array.from(new Set(parts)).join("; ") : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["_value", "label", "prefLabel", "name", "title", "notation", "@id"]) {
      const s = text(o[k]);
      if (s) return s;
    }
  }
  return null;
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof v === "object" && "_value" in (v as Record<string, unknown>)) return num((v as Record<string, unknown>)._value);
  return null;
}

/** Last path segment of a URI (or the notation of a resource object). */
export function lastSegment(v: unknown): string | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.notation === "string") return o.notation;
    return lastSegment(o["@id"]);
  }
  if (typeof v !== "string") return null;
  const s = v.replace(/[/#]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("#"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function round(v: number | null, dp = 2): number | null {
  if (v === null) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Keeps `raw` payloads to a sane size for the UI. */
export function trimItems<T extends EaList<unknown>>(data: T, max = 200): T {
  if (!data || !Array.isArray(data.items) || data.items.length <= max) return data;
  return { ...data, items: data.items.slice(0, max), meta: { ...(data.meta ?? {}), truncatedTo: max } };
}
