"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type Utility = "electricity" | "gas";

interface Consent {
  id: string;
  mpxn: string;
  utilities: Utility[];
  assetRef?: string;
  siteAddress?: string;
  occupierName: string;
  occupierEmail?: string;
  occupierOrganisation?: string;
  method: string;
  evidenceRef?: string;
  grantedOn: string;
  expiresOn: string;
  status: "pending" | "active" | "withdrawn";
  effectiveStatus: "pending" | "active" | "withdrawn" | "expired";
  daysToExpiry: number;
  notes?: string;
  lastVerifiedAt?: string;
  lastVerificationResult?: string;
  lastVerificationDetail?: string;
  withdrawnAt?: string;
  withdrawnReason?: string;
}

const METHODS: Record<string, string> = {
  n3rgy_consumer_portal: "n3rgy consumer portal",
  letter_of_authority: "Letter of authority",
  contract_clause: "Lease / contract clause",
  other: "Other",
};

const today = () => new Date().toISOString().slice(0, 10);
const plusTwelveMonths = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() + 12);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
};

const STATUS_COLOURS: Record<Consent["effectiveStatus"], string> = {
  active: "#1e7e34",
  pending: "#856404",
  expired: "#b02a37",
  withdrawn: "#6c757d",
};

export default function ConsentsPage() {
  const [consents, setConsents] = useState<Consent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [mpxn, setMpxn] = useState("");
  const [utilities, setUtilities] = useState<Utility[]>(["electricity"]);
  const [assetRef, setAssetRef] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [occupierName, setOccupierName] = useState("");
  const [occupierEmail, setOccupierEmail] = useState("");
  const [occupierOrganisation, setOccupierOrganisation] = useState("");
  const [method, setMethod] = useState("n3rgy_consumer_portal");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [grantedOn, setGrantedOn] = useState(today());
  const [expiresOn, setExpiresOn] = useState(plusTwelveMonths(today()));
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/consents");
      const body = await res.json();
      setConsents(body.consents ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/consents")
      .then((r) => r.json())
      .then((b) => {
        if (active) setConsents(b.consents ?? []);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy("create");
    try {
      const res = await fetch("/api/consents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mpxn: mpxn.replace(/\s+/g, ""),
          utilities,
          assetRef: assetRef || undefined,
          siteAddress: siteAddress || undefined,
          occupierName,
          occupierEmail: occupierEmail || undefined,
          occupierOrganisation: occupierOrganisation || undefined,
          method,
          evidenceRef: evidenceRef || undefined,
          grantedOn,
          expiresOn,
          notes: notes || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.issues?.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ") ?? body.error);
      } else {
        setNotice(`Consent recorded for ${body.consent.mpxn}. Verify it to confirm n3rgy grants access.`);
        setMpxn("");
        setOccupierName("");
        setEvidenceRef("");
        setNotes("");
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  async function verify(c: Consent) {
    setBusy(c.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/consents/${c.id}/verify`, { method: "POST" });
      const body = await res.json();
      if (!res.ok && !body.consent) setError(body.error ?? `Verify failed (${res.status})`);
      else setNotice(`${c.mpxn}: ${body.result}. ${body.detail ?? ""}`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function patch(c: Consent, patchBody: Record<string, unknown>) {
    setBusy(c.id);
    setError(null);
    try {
      const res = await fetch(`/api/consents/${c.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!res.ok) setError((await res.json()).error ?? `Update failed (${res.status})`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  function withdraw(c: Consent) {
    const reason = window.prompt(`Withdraw consent for ${c.mpxn}? Enter a reason.`);
    if (reason === null) return;
    patch(c, { status: "withdrawn", withdrawnReason: reason || undefined });
  }

  function renew(c: Consent) {
    const next = window.prompt(`New expiry date for ${c.mpxn} (YYYY-MM-DD)`, plusTwelveMonths(today()));
    if (!next) return;
    patch(c, { expiresOn: next, status: c.status === "withdrawn" ? "pending" : c.status });
  }

  return (
    <>
      <h1>Meter data consents</h1>
      <p style={{ color: "#555" }}>
        n3rgy only releases data for a supply point once the occupier has consented to our organisation. Record each consent
        here, then verify it against n3rgy. Live pulls on <Link href="/meters/n3rgy">the meters page</Link> require an active
        consent for the MPxN and utility.
      </p>

      {error && <p style={box("#f8d7da", "#f1aeb5")}>{error}</p>}
      {notice && <p style={box("#d1e7dd", "#a3cfbb")}>{notice}</p>}

      <details open={consents.length === 0} style={{ marginBottom: 24 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Record a consent</summary>
        <form onSubmit={onCreate} style={{ display: "grid", gap: 10, maxWidth: 640, marginTop: 12 }}>
          <label>
            MPAN / MPRN
            <input value={mpxn} onChange={(e) => setMpxn(e.target.value)} required pattern="[0-9 ]{6,15}" style={input} />
          </label>
          <fieldset style={{ border: "1px solid #ddd", padding: 8 }}>
            <legend>Utilities covered</legend>
            {(["electricity", "gas"] as Utility[]).map((u) => (
              <label key={u} style={{ marginRight: 16 }}>
                <input
                  type="checkbox"
                  checked={utilities.includes(u)}
                  onChange={(e) =>
                    setUtilities(e.target.checked ? [...utilities, u] : utilities.filter((x) => x !== u))
                  }
                />{" "}
                {u}
              </label>
            ))}
          </fieldset>
          <div style={row}>
            <label style={{ flex: 1 }}>
              Asset / site reference
              <input value={assetRef} onChange={(e) => setAssetRef(e.target.value)} style={input} />
            </label>
            <label style={{ flex: 2 }}>
              Site address
              <input value={siteAddress} onChange={(e) => setSiteAddress(e.target.value)} style={input} />
            </label>
          </div>
          <div style={row}>
            <label style={{ flex: 1 }}>
              Occupier name
              <input value={occupierName} onChange={(e) => setOccupierName(e.target.value)} required style={input} />
            </label>
            <label style={{ flex: 1 }}>
              Occupier email
              <input type="email" value={occupierEmail} onChange={(e) => setOccupierEmail(e.target.value)} style={input} />
            </label>
            <label style={{ flex: 1 }}>
              Occupier organisation
              <input value={occupierOrganisation} onChange={(e) => setOccupierOrganisation(e.target.value)} style={input} />
            </label>
          </div>
          <div style={row}>
            <label style={{ flex: 1 }}>
              How consent was given
              <select value={method} onChange={(e) => setMethod(e.target.value)} style={input}>
                {Object.entries(METHODS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              Evidence reference
              <input
                value={evidenceRef}
                onChange={(e) => setEvidenceRef(e.target.value)}
                placeholder="n3rgy consent id, LoA document, lease clause"
                style={input}
              />
            </label>
          </div>
          <div style={row}>
            <label>
              Granted on
              <input
                type="date"
                value={grantedOn}
                onChange={(e) => {
                  setGrantedOn(e.target.value);
                  setExpiresOn(plusTwelveMonths(e.target.value));
                }}
                required
                style={input}
              />
            </label>
            <label>
              Expires on
              <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} required style={input} />
            </label>
          </div>
          <label>
            Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={input} />
          </label>
          <button type="submit" disabled={busy === "create" || utilities.length === 0} style={{ padding: "10px 16px", width: "fit-content" }}>
            {busy === "create" ? "Saving…" : "Record consent"}
          </button>
        </form>
      </details>

      <h2 style={{ fontSize: 18 }}>Recorded consents ({consents.length})</h2>
      {consents.length === 0 && <p>None yet.</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["MPxN", "Utilities", "Occupier", "Asset", "Method", "Granted", "Expires", "Status", "Last verified", ""].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {consents.map((c) => (
              <tr key={c.id}>
                <td style={td}>
                  <code>{c.mpxn}</code>
                </td>
                <td style={td}>{c.utilities.join(", ")}</td>
                <td style={td}>
                  {c.occupierName}
                  {c.occupierOrganisation && <div style={{ color: "#666", fontSize: 12 }}>{c.occupierOrganisation}</div>}
                </td>
                <td style={td}>{c.assetRef ?? ""}</td>
                <td style={td}>
                  {METHODS[c.method] ?? c.method}
                  {c.evidenceRef && <div style={{ color: "#666", fontSize: 12 }}>{c.evidenceRef}</div>}
                </td>
                <td style={td}>{c.grantedOn}</td>
                <td style={td}>
                  {c.expiresOn}
                  {c.effectiveStatus === "active" && c.daysToExpiry <= 30 && (
                    <div style={{ color: "#b02a37", fontSize: 12 }}>{c.daysToExpiry} days left</div>
                  )}
                </td>
                <td style={{ ...td, color: STATUS_COLOURS[c.effectiveStatus], fontWeight: 600 }}>
                  {c.effectiveStatus}
                  {c.withdrawnReason && <div style={{ color: "#666", fontSize: 12, fontWeight: 400 }}>{c.withdrawnReason}</div>}
                </td>
                <td style={td}>
                  {c.lastVerifiedAt ? (
                    <>
                      {c.lastVerificationResult}
                      <div style={{ color: "#666", fontSize: 12 }} title={c.lastVerificationDetail}>
                        {c.lastVerifiedAt.slice(0, 16).replace("T", " ")}
                      </div>
                    </>
                  ) : (
                    "never"
                  )}
                </td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button onClick={() => verify(c)} disabled={busy === c.id || c.effectiveStatus === "withdrawn"} style={btn}>
                    Verify
                  </button>
                  <button onClick={() => renew(c)} disabled={busy === c.id} style={btn}>
                    Renew
                  </button>
                  <button onClick={() => withdraw(c)} disabled={busy === c.id || c.effectiveStatus === "withdrawn"} style={btn}>
                    Withdraw
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const input = { display: "block", width: "100%", padding: 8, boxSizing: "border-box" as const };
const row = { display: "flex", gap: 12, flexWrap: "wrap" as const };
const th = { textAlign: "left" as const, borderBottom: "1px solid #ccc", padding: "6px 8px", fontSize: 13 };
const td = { borderBottom: "1px solid #eee", padding: "6px 8px", fontSize: 13, verticalAlign: "top" as const };
const btn = { marginRight: 6, padding: "4px 8px", fontSize: 12 };
const box = (bg: string, border: string) => ({ background: bg, padding: 12, border: `1px solid ${border}` });
