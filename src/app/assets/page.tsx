"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

interface Asset { id: string; name: string; uprn?: string; address?: string; postcode?: string; latitude?: number; longitude?: number; floorAreaM2?: number; propertyType?: string; meters: number; lastScreening: string | null }

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", uprn: "", address: "", postcode: "", floorAreaM2: "", propertyType: "" });

  useEffect(() => {
    let active = true;
    fetch("/api/assets").then((r) => r.json()).then((b) => { if (active) setAssets(b.assets ?? []); }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function reload() {
    const b = await (await fetch("/api/assets")).json();
    setAssets(b.assets ?? []);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/assets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const b = await res.json();
      if (!res.ok) {
        setError(b.issues?.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ") ?? b.error);
        return;
      }
      if (form.postcode) await fetch(`/api/assets/${b.asset.id}/geocode`, { method: "POST" }).catch(() => {});
      setForm({ name: "", uprn: "", address: "", postcode: "", floorAreaM2: "", propertyType: "" });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Assets</h1>
      <p style={{ color: "#555" }}>
        Buildings and sites. Each asset links to its meters so readings, consents, carbon and environmental screening roll up in one place.
      </p>
      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}
      <details open={assets.length === 0} style={{ marginBottom: 20 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Add an asset</summary>
        <form onSubmit={onCreate} style={{ display: "grid", gap: 10, maxWidth: 640, marginTop: 12 }}>
          <label>Name *<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={input} /></label>
          <div style={row}>
            <label style={{ flex: 2 }}>Address<input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} style={input} /></label>
            <label style={{ flex: 1 }}>Postcode<input value={form.postcode} onChange={(e) => setForm({ ...form, postcode: e.target.value })} placeholder="SW1A 1AA" style={input} /></label>
          </div>
          <div style={row}>
            <label style={{ flex: 1 }}>UPRN<input value={form.uprn} onChange={(e) => setForm({ ...form, uprn: e.target.value })} style={input} /></label>
            <label style={{ flex: 1 }}>Floor area (m²)<input type="number" step="any" value={form.floorAreaM2} onChange={(e) => setForm({ ...form, floorAreaM2: e.target.value })} style={input} /></label>
            <label style={{ flex: 1 }}>Property type<input value={form.propertyType} onChange={(e) => setForm({ ...form, propertyType: e.target.value })} placeholder="Office, industrial…" style={input} /></label>
          </div>
          <p style={{ fontSize: 12, color: "#666", margin: 0 }}>Coordinates are filled from the postcode via postcodes.io; adjust on the asset page for large sites.</p>
          <button type="submit" disabled={busy} style={{ padding: "8px 14px", width: "fit-content" }}>{busy ? "Saving…" : "Add asset"}</button>
        </form>
      </details>

      {assets.length === 0 ? <p>No assets yet.</p> : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>{["Asset", "Postcode", "UPRN", "Floor area", "Location", "Meters", "Last screening"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id}>
                <td style={td}><Link href={`/assets/${a.id}`} style={{ fontWeight: 600 }}>{a.name}</Link>{a.address && <div style={{ color: "#666", fontSize: 12 }}>{a.address}</div>}</td>
                <td style={td}>{a.postcode ?? ""}</td>
                <td style={td}>{a.uprn ?? ""}</td>
                <td style={td}>{a.floorAreaM2 ? `${a.floorAreaM2} m²` : ""}</td>
                <td style={td}>{a.latitude !== undefined ? `${a.latitude.toFixed(4)}, ${a.longitude?.toFixed(4)}` : <span style={{ color: "#b02a37" }}>none</span>}</td>
                <td style={td}>{a.meters}</td>
                <td style={td}>{a.lastScreening ? a.lastScreening.slice(0, 10) : "never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const input = { display: "block", width: "100%", padding: 8, boxSizing: "border-box" as const };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 13 };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 13, verticalAlign: "top" as const };
const box = (bg: string, border: string) => ({ background: bg, padding: 12, border: `1px solid ${border}`, fontSize: 13 });
