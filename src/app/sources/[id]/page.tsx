"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";

interface ParamSpec {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
}
interface Operation { id: string; label: string; description: string; params: ParamSpec[] }
interface Source {
  id: string; name: string; group: string; access: string; territory: string; description: string; docsUrl: string; termsUrl?: string;
  attribution: string; licence: string; status: string; notes: string[];
  envVars: { name: string; required: boolean; description: string; set: boolean }[];
  configured: boolean; missing: string[]; hasHealthCheck: boolean; operations: Operation[];
}
interface Result {
  summary: string; columns?: string[]; rows?: Record<string, unknown>[]; raw?: unknown;
  provenance: Record<string, unknown>; warnings?: string[]; links?: { label: string; url: string }[];
}

export default function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string | null>(null);
  const [activeOp, setActiveOp] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/sources/${id}`)
      .then((r) => r.json())
      .then((b) => {
        if (!active) return;
        if (b.error) setError(b.error);
        else setSource(b.source);
      })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [id]);

  const op = source?.operations.find((o) => o.id === activeOp) ?? source?.operations[0] ?? null;

  function valueFor(p: ParamSpec) {
    return values[`${op?.id}:${p.name}`] ?? (p.default !== undefined ? String(p.default) : "");
  }

  async function runHealth() {
    setHealth("checking…");
    const res = await fetch(`/api/sources/${id}/health`, { method: "POST" });
    const b = await res.json();
    setHealth(`${b.ok ? "OK" : "FAIL"}: ${b.detail}${b.latencyMs !== undefined ? ` (${b.latencyMs} ms)` : ""}`);
  }

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!op) return;
    setBusy(true);
    setOpError(null);
    setResult(null);
    const body: Record<string, unknown> = {};
    for (const p of op.params) {
      const v = valueFor(p);
      if (p.type === "boolean") body[p.name] = v === "true";
      else if (v !== "") body[p.name] = v;
    }
    try {
      const res = await fetch(`/api/sources/${id}/ops/${op.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const b = await res.json();
      if (!res.ok) {
        const issues = b.issues?.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ");
        setOpError([b.error, issues, b.upstreamStatus ? `upstream HTTP ${b.upstreamStatus}` : null, b.upstreamBody].filter(Boolean).join(" · "));
      } else {
        setResult(b.result);
      }
    } catch (err) {
      setOpError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>;
  if (!source) return <p>Loading…</p>;

  const columns = result?.columns ?? (result?.rows?.[0] ? Object.keys(result.rows[0]) : []);

  return (
    <>
      <p style={{ fontSize: 13 }}><Link href="/sources">← All data sources</Link></p>
      <h1 style={{ marginBottom: 4 }}>{source.name}</h1>
      <p style={{ color: "#555", marginTop: 0 }}>{source.description}</p>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", fontSize: 13, maxWidth: 720 }}>
        <dt>Access</dt><dd style={dd}>{source.access}</dd>
        <dt>Territory</dt><dd style={dd}>{source.territory}</dd>
        <dt>Licence</dt><dd style={dd}>{source.licence}</dd>
        <dt>Status</dt><dd style={dd}>{source.status.replace("_", ", ")}</dd>
        <dt>Docs</dt><dd style={dd}><a href={source.docsUrl} target="_blank" rel="noreferrer">{source.docsUrl}</a>{source.termsUrl && <> · <a href={source.termsUrl} target="_blank" rel="noreferrer">terms</a></>}</dd>
        <dt>Attribution</dt><dd style={dd}>{source.attribution}</dd>
      </dl>

      {source.envVars.length > 0 && (
        <section style={{ marginTop: 12 }}>
          <h2 style={h2}>Configuration</h2>
          <ul style={{ fontSize: 13 }}>
            {source.envVars.map((v) => (
              <li key={v.name}>
                <code>{v.name}</code> {v.required ? "(required)" : "(optional)"} — {v.description}{" "}
                <span style={{ color: v.set ? "#1e7e34" : "#b02a37" }}>{v.set ? "set" : "not set"}</span>
              </li>
            ))}
          </ul>
          {!source.configured && <p style={box("#fff3cd", "#ffe69c")}>Add {source.missing.join(", ")} to .env.local and restart to use this source.</p>}
        </section>
      )}

      {source.notes.length > 0 && (
        <section style={{ marginTop: 12 }}>
          <h2 style={h2}>Notes</h2>
          <ul style={{ fontSize: 13 }}>{source.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
      )}

      {source.hasHealthCheck && source.status !== "reference_only" && (
        <p><button onClick={runHealth} disabled={!source.configured} style={{ padding: "6px 12px" }}>Test connection</button> {health && <span style={{ fontSize: 13, marginLeft: 8 }}>{health}</span>}</p>
      )}

      {source.operations.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <h2 style={h2}>Operations</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {source.operations.map((o) => (
              <button key={o.id} onClick={() => { setActiveOp(o.id); setResult(null); setOpError(null); }} style={{ padding: "6px 10px", fontSize: 13, background: op?.id === o.id ? "#1a1a1a" : "#fff", color: op?.id === o.id ? "#fff" : "#1a1a1a", border: "1px solid #999" }}>
                {o.label}
              </button>
            ))}
          </div>
          {op && (
            <form onSubmit={run} style={{ display: "grid", gap: 10, maxWidth: 640, background: "#fff", border: "1px solid #ddd", padding: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#555" }}>{op.description}</p>
              {op.params.map((p) => (
                <label key={p.name} style={{ fontSize: 13 }}>
                  {p.label}{p.required ? " *" : ""}
                  {p.type === "select" ? (
                    <select value={valueFor(p)} onChange={(e) => setValues({ ...values, [`${op.id}:${p.name}`]: e.target.value })} style={input}>
                      {!p.required && <option value="">—</option>}
                      {p.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : p.type === "text" ? (
                    <textarea rows={4} value={valueFor(p)} placeholder={p.placeholder} onChange={(e) => setValues({ ...values, [`${op.id}:${p.name}`]: e.target.value })} style={input} />
                  ) : p.type === "boolean" ? (
                    <select value={valueFor(p) || "false"} onChange={(e) => setValues({ ...values, [`${op.id}:${p.name}`]: e.target.value })} style={input}>
                      <option value="false">No</option><option value="true">Yes</option>
                    </select>
                  ) : (
                    <input
                      type={p.type === "date" ? "date" : ["number", "integer", "latitude", "longitude"].includes(p.type) ? "number" : "text"}
                      step={["number", "latitude", "longitude"].includes(p.type) ? "any" : undefined}
                      value={valueFor(p)}
                      placeholder={p.placeholder}
                      required={p.required}
                      onChange={(e) => setValues({ ...values, [`${op.id}:${p.name}`]: e.target.value })}
                      style={input}
                    />
                  )}
                  {p.help && <div style={{ color: "#666", fontSize: 12 }}>{p.help}</div>}
                </label>
              ))}
              <button type="submit" disabled={busy || !source.configured} style={{ padding: "8px 14px", width: "fit-content" }}>{busy ? "Running…" : "Run"}</button>
            </form>
          )}
          {opError && <p style={box("#f8d7da", "#f1aeb5")}>{opError}</p>}
          {result && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontWeight: 600 }}>{result.summary}</p>
              {result.warnings?.map((w, i) => <p key={i} style={box("#fff3cd", "#ffe69c")}>{w}</p>)}
              {result.links && result.links.length > 0 && (
                <ul style={{ fontSize: 13 }}>{result.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a></li>)}</ul>
              )}
              {result.rows && result.rows.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead><tr>{columns.map((c) => <th key={c} style={th}>{c}</th>)}</tr></thead>
                    <tbody>
                      {result.rows.slice(0, 200).map((r, i) => (
                        <tr key={i}>{columns.map((c) => <td key={c} style={td}>{format(r[c])}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  {result.rows.length > 200 && <p style={{ fontSize: 12, color: "#666" }}>Showing 200 of {result.rows.length} rows.</p>}
                </div>
              )}
              <p style={{ fontSize: 12, color: "#666" }}>
                Source {String(result.provenance.source)} · basis {String(result.provenance.basis)} · licence {String(result.provenance.licence)} · retrieved {String(result.provenance.retrievedAt)}. {source.attribution}
              </p>
              <button onClick={() => setShowRaw(!showRaw)} style={{ fontSize: 12 }}>{showRaw ? "Hide" : "Show"} raw response</button>
              {showRaw && <pre style={{ fontSize: 11, background: "#fff", border: "1px solid #ddd", padding: 8, overflowX: "auto", maxHeight: 400 }}>{JSON.stringify(result.raw ?? result, null, 2)}</pre>}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function format(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const h2 = { fontSize: 16, marginBottom: 6 };
const dd = { margin: 0 };
const input = { display: "block", width: "100%", padding: 8, boxSizing: "border-box" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 12, whiteSpace: "nowrap" as const };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 12, verticalAlign: "top" as const, maxWidth: 320, overflowWrap: "anywhere" as const };
const box = (bg: string, border: string) => ({ background: bg, padding: 12, border: `1px solid ${border}`, fontSize: 13 });
