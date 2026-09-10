import { useState } from 'react'
import { api, fmt } from '../api'
import { useLoad } from '../hooks'
import { Bar, Cat, Stat, Status, TierPill } from '../components/bits'
import { LineageDrawer } from '../components/LineageDrawer'

export function InventoryView({ period }: { period: number }) {
  const { data, error, loading } = useLoad(() => api.inventory(period), [period])
  const [open, setOpen] = useState<number | null>(null)
  return (
    <>
      <h1>Scope 3 inventory · {period}</h1>
      <p className="sub">Every figure carries its factor source and version. Click a row for its lineage.</p>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <Stat label="Total" value={fmt.t(data.total_tco2e)} unit="tCO₂e" />
            <Stat label="Primary data (tiers A+B)" value={fmt.pct(data.primary_share)} />
            <Stat label="Achievable primary share" value={data.trajectory ? fmt.pct(data.trajectory.achievable_primary_share) : '—'} unit={data.trajectory ? `+${fmt.t(data.trajectory.uplift_tco2e)} t uplift` : undefined} />
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>ESRS E1-6 quality by category</h2>
            <table>
              <thead><tr><th>Category</th><th className="num">tCO₂e</th><th className="num">Primary</th><th style={{ width: 160 }}>Primary share</th><th className="num">DQ score</th></tr></thead>
              <tbody>
                {data.categories.map((c) => (
                  <tr key={c.category}>
                    <td><Cat id={c.category} /></td>
                    <td className="num">{fmt.t(c.total_tco2e)}</td>
                    <td className="num">{fmt.t(c.primary_tco2e)}</td>
                    <td><Bar share={c.primary_share} /></td>
                    <td className="num">{c.weighted_dq_score.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>Figures</h2>
            <table>
              <thead><tr><th>#</th><th>Category</th><th>Counterparty</th><th className="num">tCO₂e</th><th>Tier</th><th>Achievable</th><th>Factor</th><th>Evidence</th></tr></thead>
              <tbody>
                {data.figures.map((f) => (
                  <tr key={f.id} className="clickable" onClick={() => setOpen(f.id)} data-testid="figure-row">
                    <td className="num">{f.id}</td>
                    <td><Cat id={f.category} /></td>
                    <td>{f.counterparty_id ?? <span className="muted">—</span>}</td>
                    <td className="num">{fmt.t(f.tco2e)}</td>
                    <td><TierPill tier={f.tier} /></td>
                    <td><TierPill tier={f.achievable_tier} /></td>
                    <td>{f.factor_source} <span className="muted">{f.factor_version}</span></td>
                    <td>{f.document_id ?? <span className="muted">none</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {open !== null && <LineageDrawer figureId={open} onClose={() => setOpen(null)} />}
    </>
  )
}
