"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";

interface MoslMember {
  id: string;
  name: string;
  shortName: string;
  roles: string[];
  notes?: string;
}

interface SupplyPoint {
  id: string;
  spid: string;
  service: string;
  label?: string;
  postcode?: string;
  retailerId?: string;
  wholesalerId?: string;
  propertyType?: string;
  floorAreaM2?: number;
  occupants?: number;
}

interface Reading {
  id: string;
  supplyPointId: string;
  periodStart: string;
  periodEnd: string;
  volumeM3: number;
  basis: string;
  source: string;
  evidence?: string;
  unitCostGbpPerM3?: number;
}

interface Summary {
  supplyPointCount: number;
  readingCount: number;
  totalM3: number;
  costGbp: number | null;
  byBasis: Record<string, number>;
  bySupplyPoint: {
    supplyPoint: SupplyPoint;
    readingCount: number;
    totalM3: number;
    costGbp: number | null;
  }[];
}

interface BenchmarkEstimate {
  propertyType: string;
  label: string;
  m3: number;
  method: string;
  days: number;
  source: string;
  notes: string;
  warnings: string[];
  litresPerPersonPerDay?: number;
  m3PerM2PerYear?: number;
}

const PROPERTY_TYPES = [
  "office",
  "retail",
  "warehouse",
  "hotel",
  "restaurant",
  "school",
  "hospital",
  "industrial",
  "residential",
  "mixed_use",
] as const;

const input: CSSProperties = { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" };
const box = (bg: string, border: string): CSSProperties => ({ background: bg, border: `1px solid ${border}`, padding: 12, marginTop: 12 });
const th: CSSProperties = { textAlign: "left", borderBottom: "1px solid #ddd", padding: "6px 8px", fontSize: 13 };
const td: CSSProperties = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 13 };

function fmt(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-GB", { maximumFractionDigits: digits });
}

export default function WaterPage() {
  const [members, setMembers] = useState<MoslMember[]>([]);
  const [memberQ, setMemberQ] = useState("");
  const [memberRole, setMemberRole] = useState("");
  const [supplyPoints, setSupplyPoints] = useState<SupplyPoint[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [spid, setSpid] = useState("");
  const [service, setService] = useState("water");
  const [label, setLabel] = useState("");
  const [postcode, setPostcode] = useState("");
  const [retailerId, setRetailerId] = useState("");
  const [wholesalerId, setWholesalerId] = useState("");
  const [propertyType, setPropertyType] = useState<(typeof PROPERTY_TYPES)[number]>("office");
  const [floorAreaM2, setFloorAreaM2] = useState("");
  const [occupants, setOccupants] = useState("");

  const [supplyPointId, setSupplyPointId] = useState("");
  const [periodStart, setPeriodStart] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [volume, setVolume] = useState("");
  const [unit, setUnit] = useState("m3");
  const [basis, setBasis] = useState("client_declared");
  const [source, setSource] = useState("bill");
  const [evidence, setEvidence] = useState("");
  const [unitCost, setUnitCost] = useState("");

  const [benchType, setBenchType] = useState<(typeof PROPERTY_TYPES)[number]>("office");
  const [benchArea, setBenchArea] = useState("1000");
  const [benchOccupants, setBenchOccupants] = useState("");
  const [benchDays, setBenchDays] = useState("365");
  const [estimate, setEstimate] = useState<BenchmarkEstimate | null>(null);

  const refresh = useCallback(async () => {
    const [spRes, consRes, sumRes] = await Promise.all([
      fetch("/api/water/supply-points"),
      fetch("/api/water/consumption"),
      fetch("/api/water/summary"),
    ]);
    const spBody = await spRes.json();
    const consBody = await consRes.json();
    const sumBody = await sumRes.json();
    setSupplyPoints(spBody.supplyPoints ?? []);
    setReadings(consBody.readings ?? []);
    setSummary(sumBody.summary ?? null);
    if (spBody.supplyPoints?.length) {
      setSupplyPointId((current) => current || spBody.supplyPoints[0].id);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([fetch("/api/water/supply-points"), fetch("/api/water/consumption"), fetch("/api/water/summary")])
      .then(async ([spRes, consRes, sumRes]) => {
        const spBody = await spRes.json();
        const consBody = await consRes.json();
        const sumBody = await sumRes.json();
        if (!active) return;
        setSupplyPoints(spBody.supplyPoints ?? []);
        setReadings(consBody.readings ?? []);
        setSummary(sumBody.summary ?? null);
        if (spBody.supplyPoints?.length) {
          setSupplyPointId((current) => current || spBody.supplyPoints[0].id);
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    if (memberQ.trim()) params.set("q", memberQ.trim());
    if (memberRole) params.set("role", memberRole);
    fetch(`/api/water/members?${params}`)
      .then((r) => r.json())
      .then((b) => {
        if (active) setMembers(b.members ?? []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [memberQ, memberRole]);

  async function addSupplyPoint(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/water/supply-points", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spid,
          service,
          label: label || undefined,
          postcode: postcode || undefined,
          retailerId: retailerId || undefined,
          wholesalerId: wholesalerId || undefined,
          propertyType,
          floorAreaM2: floorAreaM2 || undefined,
          occupants: occupants || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Failed (${res.status})`);
      else {
        setSpid("");
        setLabel("");
        await refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addReading(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/water/consumption", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          supplyPointId,
          periodStart,
          periodEnd,
          volume: Number(volume),
          unit,
          basis,
          source,
          evidence: evidence || undefined,
          unitCostGbpPerM3: unitCost ? Number(unitCost) : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? body.issues?.[0]?.message ?? `Failed (${res.status})`);
      else {
        setVolume("");
        setEvidence("");
        await refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runBenchmark(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setEstimate(null);
    try {
      const params = new URLSearchParams({ propertyType: benchType, days: benchDays });
      if (benchArea) params.set("floorAreaM2", benchArea);
      if (benchOccupants) params.set("occupants", benchOccupants);
      const res = await fetch(`/api/water/benchmark?${params}`);
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Failed (${res.status})`);
      else setEstimate(body.estimate);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const retailers = members.filter((m) => m.roles.includes("retailer") || m.roles.includes("self_supply"));
  const wholesalers = members.filter((m) => m.roles.includes("wholesaler"));

  return (
    <>
      <h1>UK property water consumption</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Record SPIDs and water use for UK properties, look up MOSL trading parties, and screen sites with indicative
        benchmarks. Live CMOS meter data needs a{" "}
        <a href="https://mosl.co.uk/documents-publications/11006-third-party-data-request-guidance/file">MOSL third-party data request</a>{" "}
        with customer consent — until then, enter bill or retailer figures here. Carbon for water supply and treatment
        still runs through <Link href="/emissions">refrigerants, water and waste</Link>.
      </p>

      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}

      {summary && (
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, margin: "16px 0" }}>
          <Stat label="Supply points" value={String(summary.supplyPointCount)} />
          <Stat label="Readings" value={String(summary.readingCount)} />
          <Stat label="Total volume" value={`${fmt(summary.totalM3)} m³`} />
          <Stat label="Indicative cost" value={summary.costGbp === null ? "—" : `£${fmt(summary.costGbp, 0)}`} />
        </section>
      )}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18 }}>Register a supply point</h2>
        <p style={{ fontSize: 13, color: "#555" }}>
          England non-household SPIDs are 10-digit CMOS identifiers. Household or other meter references are accepted as a stable site key.
        </p>
        <form onSubmit={addSupplyPoint} style={{ display: "grid", gap: 10, maxWidth: 640, background: "#fff", border: "1px solid #ddd", padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ fontSize: 13 }}>SPID / meter ref<input value={spid} onChange={(e) => setSpid(e.target.value)} required pattern="[A-Za-z0-9-]{6,20}" style={input} placeholder="3012345678" /></label>
            <label style={{ fontSize: 13 }}>Service
              <select value={service} onChange={(e) => setService(e.target.value)} style={input}>
                <option value="water">Water</option>
                <option value="sewerage">Sewerage</option>
                <option value="water_and_sewerage">Water and sewerage</option>
              </select>
            </label>
            <label style={{ fontSize: 13 }}>Label<input value={label} onChange={(e) => setLabel(e.target.value)} style={input} placeholder="Main incoming" /></label>
            <label style={{ fontSize: 13 }}>Postcode<input value={postcode} onChange={(e) => setPostcode(e.target.value)} style={input} placeholder="SW1A 1AA" /></label>
            <label style={{ fontSize: 13 }}>Retailer
              <select value={retailerId} onChange={(e) => setRetailerId(e.target.value)} style={input}>
                <option value="">—</option>
                {retailers.map((m) => <option key={m.id} value={m.id}>{m.shortName}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 13 }}>Wholesaler
              <select value={wholesalerId} onChange={(e) => setWholesalerId(e.target.value)} style={input}>
                <option value="">—</option>
                {wholesalers.map((m) => <option key={m.id} value={m.id}>{m.shortName}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 13 }}>Property type
              <select value={propertyType} onChange={(e) => setPropertyType(e.target.value as (typeof PROPERTY_TYPES)[number])} style={input}>
                {PROPERTY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 13 }}>Floor area (m²)<input value={floorAreaM2} onChange={(e) => setFloorAreaM2(e.target.value)} type="number" min="0" step="any" style={input} /></label>
            <label style={{ fontSize: 13 }}>Occupants / FTE<input value={occupants} onChange={(e) => setOccupants(e.target.value)} type="number" min="0" step="any" style={input} /></label>
          </div>
          <button type="submit" disabled={busy} style={{ padding: "8px 14px", width: "fit-content" }}>{busy ? "Saving…" : "Add supply point"}</button>
        </form>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 18 }}>Record consumption</h2>
        <form onSubmit={addReading} style={{ display: "grid", gap: 10, maxWidth: 640, background: "#fff", border: "1px solid #ddd", padding: 12 }}>
          <label style={{ fontSize: 13 }}>Supply point
            <select value={supplyPointId} onChange={(e) => setSupplyPointId(e.target.value)} required style={input}>
              <option value="" disabled>Select…</option>
              {supplyPoints.map((sp) => (
                <option key={sp.id} value={sp.id}>{sp.spid}{sp.label ? ` — ${sp.label}` : ""}</option>
              ))}
            </select>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ fontSize: 13 }}>Period start<input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required style={input} /></label>
            <label style={{ fontSize: 13 }}>Period end<input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required style={input} /></label>
            <label style={{ fontSize: 13 }}>Volume<input value={volume} onChange={(e) => setVolume(e.target.value)} type="number" min="0" step="any" required style={input} /></label>
            <label style={{ fontSize: 13 }}>Unit
              <select value={unit} onChange={(e) => setUnit(e.target.value)} style={input}>
                <option value="m3">m³</option>
                <option value="litres">Litres</option>
              </select>
            </label>
            <label style={{ fontSize: 13 }}>Basis
              <select value={basis} onChange={(e) => setBasis(e.target.value)} style={input}>
                <option value="client_declared">Client declared (bill)</option>
                <option value="measured">Measured (meter / CMOS)</option>
                <option value="estimated">Estimated (benchmark)</option>
              </select>
            </label>
            <label style={{ fontSize: 13 }}>Source
              <select value={source} onChange={(e) => setSource(e.target.value)} style={input}>
                <option value="bill">Bill / invoice</option>
                <option value="retailer_portal">Retailer portal</option>
                <option value="mosl_cmos">MOSL / CMOS</option>
                <option value="amr_meter">AMR / smart meter</option>
                <option value="manual">Manual</option>
                <option value="benchmark">Benchmark</option>
              </select>
            </label>
            <label style={{ fontSize: 13 }}>Evidence / invoice ref<input value={evidence} onChange={(e) => setEvidence(e.target.value)} style={input} /></label>
            <label style={{ fontSize: 13 }}>Unit cost (£/m³)<input value={unitCost} onChange={(e) => setUnitCost(e.target.value)} type="number" min="0" step="any" style={input} /></label>
          </div>
          <button type="submit" disabled={busy || !supplyPointId} style={{ padding: "8px 14px", width: "fit-content" }}>{busy ? "Saving…" : "Add reading"}</button>
        </form>
      </section>

      {supplyPoints.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 18 }}>Supply points</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff" }}>
              <thead>
                <tr>
                  <th style={th}>SPID</th>
                  <th style={th}>Service</th>
                  <th style={th}>Postcode</th>
                  <th style={th}>Retailer</th>
                  <th style={th}>Type</th>
                  <th style={th}>Volume (m³)</th>
                </tr>
              </thead>
              <tbody>
                {summary?.bySupplyPoint.map((row) => (
                  <tr key={row.supplyPoint.id}>
                    <td style={td}>{row.supplyPoint.spid}{row.supplyPoint.label ? ` · ${row.supplyPoint.label}` : ""}</td>
                    <td style={td}>{row.supplyPoint.service.replace(/_/g, " ")}</td>
                    <td style={td}>{row.supplyPoint.postcode ?? "—"}</td>
                    <td style={td}>{row.supplyPoint.retailerId ?? "—"}</td>
                    <td style={td}>{row.supplyPoint.propertyType?.replace(/_/g, " ") ?? "—"}</td>
                    <td style={td}>{fmt(row.totalM3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {readings.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 18 }}>Recent readings</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff" }}>
              <thead>
                <tr>
                  <th style={th}>Period</th>
                  <th style={th}>SPID</th>
                  <th style={th}>m³</th>
                  <th style={th}>Basis</th>
                  <th style={th}>Source</th>
                  <th style={th}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {readings.slice(0, 20).map((r) => {
                  const sp = supplyPoints.find((s) => s.id === r.supplyPointId);
                  return (
                    <tr key={r.id}>
                      <td style={td}>{r.periodStart} → {r.periodEnd}</td>
                      <td style={td}>{sp?.spid ?? r.supplyPointId.slice(0, 8)}</td>
                      <td style={td}>{fmt(r.volumeM3, 3)}</td>
                      <td style={td}>{r.basis}</td>
                      <td style={td}>{r.source}</td>
                      <td style={td}>{r.evidence ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 18 }}>Benchmark estimate</h2>
        <p style={{ fontSize: 13, color: "#555" }}>Screen a property before meter data arrives. Never report these figures as measured.</p>
        <form onSubmit={runBenchmark} style={{ display: "grid", gap: 10, maxWidth: 640, background: "#fff", border: "1px solid #ddd", padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ fontSize: 13 }}>Property type
              <select value={benchType} onChange={(e) => setBenchType(e.target.value as (typeof PROPERTY_TYPES)[number])} style={input}>
                {PROPERTY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 13 }}>Days in period<input value={benchDays} onChange={(e) => setBenchDays(e.target.value)} type="number" min="1" style={input} /></label>
            <label style={{ fontSize: 13 }}>Floor area (m²)<input value={benchArea} onChange={(e) => setBenchArea(e.target.value)} type="number" min="0" step="any" style={input} /></label>
            <label style={{ fontSize: 13 }}>Occupants (optional)<input value={benchOccupants} onChange={(e) => setBenchOccupants(e.target.value)} type="number" min="0" step="any" style={input} /></label>
          </div>
          <button type="submit" disabled={busy} style={{ padding: "8px 14px", width: "fit-content" }}>Estimate</button>
        </form>
        {estimate && (
          <div style={box("#fff3cd", "#ffe69c")}>
            <p style={{ margin: 0, fontSize: 15 }}>
              <strong>{fmt(estimate.m3)} m³</strong> over {estimate.days} days ({estimate.label}, {estimate.method})
            </p>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#555" }}>{estimate.source}. {estimate.notes}</p>
            {estimate.warnings.map((w) => <p key={w} style={{ margin: "6px 0 0", fontSize: 13 }}>{w}</p>)}
          </div>
        )}
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 18 }}>MOSL members</h2>
        <p style={{ fontSize: 13, color: "#555" }}>
          Trading parties from <a href="https://mosl.co.uk/about/our-members">mosl.co.uk/about/our-members</a>. Filter by role or name.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <input value={memberQ} onChange={(e) => setMemberQ(e.target.value)} placeholder="Search members" style={{ ...input, width: 220, display: "inline-block" }} />
          <select value={memberRole} onChange={(e) => setMemberRole(e.target.value)} style={{ ...input, width: 180, display: "inline-block" }}>
            <option value="">All roles</option>
            <option value="wholesaler">Wholesaler</option>
            <option value="retailer">Retailer</option>
            <option value="nav">NAV</option>
            <option value="self_supply">Self-supply</option>
            <option value="third_party">Third party</option>
          </select>
        </div>
        <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto", background: "#fff", border: "1px solid #ddd" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Roles</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td style={td}>{m.name}{m.notes ? <span style={{ color: "#666" }}> — {m.notes}</span> : null}</td>
                  <td style={td}>{m.roles.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ marginTop: 28, fontSize: 13, color: "#555" }}>
        <h2 style={{ fontSize: 16, color: "#1a1a1a" }}>API</h2>
        <ul>
          <li><code>GET /api/water/members</code> — MOSL trading parties</li>
          <li><code>GET|POST /api/water/supply-points</code> — SPIDs linked to properties</li>
          <li><code>GET|POST /api/water/consumption</code> — period volumes (JSON or batch import)</li>
          <li><code>GET /api/water/summary</code> — portfolio roll-up</li>
          <li><code>GET /api/water/benchmark</code> — indicative m³ estimate</li>
        </ul>
        <p>
          See also the <Link href="/sources/mosl-water-market">MOSL water market</Link> source entry for the third-party data request route into CMOS.
        </p>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #ddd", padding: "12px 14px" }}>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}
