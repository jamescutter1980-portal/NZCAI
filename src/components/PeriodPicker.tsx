"use client";

import { useMemo, useState } from "react";

export interface PeriodSelection {
  kind: "calendar" | "fiscal" | "rolling12";
  year: number;
  startMonth: number;
  endDate: string;
}

export function defaultPeriodSelection(now = new Date()): PeriodSelection {
  const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { kind: "calendar", year: now.getUTCFullYear() - 1, startMonth: 4, endDate: lastMonthEnd.toISOString().slice(0, 10) };
}

export function periodQuery(s: PeriodSelection): string {
  const p = new URLSearchParams({ kind: s.kind });
  if (s.kind === "calendar") p.set("year", String(s.year));
  if (s.kind === "fiscal") {
    p.set("year", String(s.year));
    p.set("startMonth", String(s.startMonth));
  }
  if (s.kind === "rolling12") p.set("endDate", s.endDate);
  return p.toString();
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Reporting period control: calendar year, financial year or rolling twelve months. */
export function PeriodPicker({ value, onChange, disabled }: { value: PeriodSelection; onChange: (v: PeriodSelection) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const years = useMemo(() => {
    const y = new Date().getUTCFullYear();
    return Array.from({ length: 8 }, (_, i) => y - i);
  }, []);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <label style={{ fontSize: 13 }}>
        Period
        <select value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as PeriodSelection["kind"] })} disabled={disabled} style={sel}>
          <option value="calendar">Calendar year</option>
          <option value="fiscal">Financial year</option>
          <option value="rolling12">Rolling 12 months</option>
        </select>
      </label>
      {value.kind !== "rolling12" && (
        <label style={{ fontSize: 13 }}>
          {value.kind === "fiscal" ? "Starting" : "Year"}
          <select value={value.year} onChange={(e) => onChange({ ...value, year: Number(e.target.value) })} disabled={disabled} style={sel}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      )}
      {value.kind === "fiscal" && (
        <label style={{ fontSize: 13 }}>
          Month
          <select value={value.startMonth} onChange={(e) => onChange({ ...value, startMonth: Number(e.target.value) })} disabled={disabled} style={sel}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
      )}
      {value.kind === "rolling12" && (
        <label style={{ fontSize: 13 }}>
          Ending
          <input type="date" value={value.endDate} onChange={(e) => onChange({ ...value, endDate: e.target.value })} disabled={disabled} style={sel} />
        </label>
      )}
      <button type="button" onClick={() => setOpen(!open)} style={{ fontSize: 11, padding: "2px 6px" }} aria-expanded={open}>
        {open ? "Hide" : "What is this?"}
      </button>
      {open && (
        <p style={{ fontSize: 12, color: "#555", flexBasis: "100%", margin: 0 }}>
          A financial or rolling period reports against the conversion factor set for the year it starts in, which is the usual UK convention. The factor set actually used is shown with the result, so check it matches your disclosure basis.
        </p>
      )}
    </div>
  );
}

const sel = { display: "block", padding: 6 };
