"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Source {
  id: string;
  name: string;
  group: string;
  access: string;
  territory: string;
  description: string;
  status: string;
  configured: boolean;
  missing: string[];
  hasHealthCheck: boolean;
  operations: { id: string; label: string }[];
}

const ACCESS_LABELS: Record<string, string> = {
  open: "Open API",
  open_key: "Open API, key",
  authorised: "Authorised",
  commercial: "Commercial",
  gis: "GIS / map service",
  download: "Download",
  enquiry: "Enquiry",
};

const STATUS_LABELS: Record<string, { label: string; colour: string }> = {
  live_verified: { label: "Live verified", colour: "#1e7e34" },
  built_unverified: { label: "Built, unverified", colour: "#856404" },
  reference_only: { label: "Reference only", colour: "#6c757d" },
  planned: { label: "Planned", colour: "#6c757d" },
};

export default function SourcesPage() {
  const [groups, setGroups] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Source[]>([]);
  const [health, setHealth] = useState<Record<string, { ok: boolean; detail: string; latencyMs?: number } | "running">>({});
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/sources")
      .then((r) => r.json())
      .then((b) => {
        if (!active) return;
        setGroups(b.groups ?? {});
        setSources(b.sources ?? []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function check(id: string) {
    setHealth((h) => ({ ...h, [id]: "running" }));
    const res = await fetch(`/api/sources/${id}/health`, { method: "POST" });
    const body = await res.json();
    setHealth((h) => ({ ...h, [id]: { ok: Boolean(body.ok), detail: body.detail ?? body.error ?? "", latencyMs: body.latencyMs } }));
  }

  async function checkAll() {
    for (const s of sources.filter((s) => s.configured && s.hasHealthCheck && s.status !== "reference_only")) {
      await check(s.id);
    }
  }

  const q = filter.trim().toLowerCase();
  const visible = sources.filter((s) => !q || `${s.name} ${s.id} ${s.description} ${s.territory}`.toLowerCase().includes(q));
  const counts = {
    total: sources.length,
    built: sources.filter((s) => s.status === "built_unverified" || s.status === "live_verified").length,
    verified: sources.filter((s) => s.status === "live_verified").length,
    configured: sources.filter((s) => s.configured && s.status !== "reference_only").length,
    reference: sources.filter((s) => s.status === "reference_only").length,
  };

  return (
    <>
      <h1>Data sources</h1>
      <p style={{ color: "#555" }}>
        Every external source the portal can talk to, grouped as in the roadmap. Open a source to run its operations, or
        run health checks to confirm this machine can reach each service with the keys in <code>.env.local</code>.
      </p>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <Stat label="Sources" value={counts.total} />
        <Stat label="With a connector" value={counts.built} />
        <Stat label="Live verified" value={counts.verified} />
        <Stat label="Configured here" value={counts.configured} />
        <Stat label="Reference only" value={counts.reference} />
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <input placeholder="Filter sources" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: 8, minWidth: 240 }} />
        <button onClick={checkAll} style={{ padding: "8px 14px" }}>Run all health checks</button>
      </div>

      {Object.entries(groups).map(([groupId, label]) => {
        const items = visible.filter((s) => s.group === groupId);
        if (items.length === 0) return null;
        return (
          <section key={groupId} style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 17, borderBottom: "1px solid #ddd", paddingBottom: 4 }}>{label}</h2>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>{["Source", "Access", "Territory", "Status", "Config", "Health", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {items.map((s) => {
                    const st = STATUS_LABELS[s.status] ?? { label: s.status, colour: "#333" };
                    const h = health[s.id];
                    return (
                      <tr key={s.id}>
                        <td style={td}>
                          <Link href={`/sources/${s.id}`} style={{ fontWeight: 600 }}>{s.name}</Link>
                          <div style={{ color: "#666", fontSize: 12, maxWidth: 420 }}>{s.description}</div>
                        </td>
                        <td style={td}>{ACCESS_LABELS[s.access] ?? s.access}</td>
                        <td style={td}>{s.territory}</td>
                        <td style={{ ...td, color: st.colour, fontWeight: 600 }}>{st.label}</td>
                        <td style={td}>
                          {s.status === "reference_only" ? "n/a" : s.configured ? <span style={{ color: "#1e7e34" }}>ready</span> : <span style={{ color: "#b02a37" }} title={s.missing.join(", ")}>needs {s.missing.join(", ")}</span>}
                        </td>
                        <td style={td}>
                          {h === "running" ? "checking…" : h ? <span style={{ color: h.ok ? "#1e7e34" : "#b02a37" }} title={h.detail}>{h.ok ? "OK" : "FAIL"}{h.latencyMs !== undefined ? ` ${h.latencyMs} ms` : ""}</span> : ""}
                          {h && h !== "running" && !h.ok && <div style={{ fontSize: 11, color: "#666", maxWidth: 260 }}>{h.detail}</div>}
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {s.hasHealthCheck && s.status !== "reference_only" && (
                            <button onClick={() => check(s.id)} disabled={!s.configured || h === "running"} style={btn}>Check</button>
                          )}
                          {s.operations.length > 0 && <Link href={`/sources/${s.id}`} style={{ fontSize: 12 }}>{s.operations.length} ops</Link>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #ddd", padding: "8px 14px", minWidth: 110 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 13 };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 13, verticalAlign: "top" as const };
const btn = { marginRight: 8, padding: "4px 8px", fontSize: 12 };
