import { useState } from 'react'
import { api, CATEGORY_NAMES, fmt } from '../api'
import { useLoad } from '../hooks'
import { Pill, Stat, Status } from '../components/bits'

const ALL = Object.keys(CATEGORY_NAMES)

// SBTi readiness. Scope 1 and 2 are typed in here because they live in the
// operational ledger, not the Scope 3 store; the engine needs them for C4.
export function CoverageView({ period }: { period: number }) {
  const [scope1, setScope1] = useState(30000)
  const [scope2, setScope2] = useState(12000)
  const [fossil, setFossil] = useState(true)
  // Which categories sit inside the target boundary. Empty means "every
  // category that has a figure", which is the engine's default.
  const [excluded, setExcluded] = useState<string[]>([])
  const covered = excluded.length ? ALL.filter((c) => !excluded.includes(c)).join(',') : undefined
  const { data, error, loading } = useLoad(() => api.coverage({ period, scope1, scope2, sells_fossil_fuel: fossil, covered }), [period, scope1, scope2, fossil, covered])
  const r = data?.result
  return (
    <>
      <h1>Target readiness · {period}</h1>
      <p className="sub">The SBTi gates the inventory would fail today, and why. Coverage counts categories inside the target boundary.</p>
      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'end', flexWrap: 'wrap' }}>
        <label>Scope 1 tCO₂e<br /><input type="number" value={scope1} onChange={(e) => setScope1(Number(e.target.value))} /></label>
        <label>Scope 2 tCO₂e<br /><input type="number" value={scope2} onChange={(e) => setScope2(Number(e.target.value))} /></label>
        <label><input type="checkbox" checked={fossil} onChange={(e) => setFossil(e.target.checked)} /> Sells fossil fuel (C22)</label>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Categories inside the target boundary</h2>
        <div className="actions">
          {ALL.map((c) => (
            <label key={c} className={`pill ${excluded.includes(c) ? 'red' : 'green'}`} style={{ cursor: 'pointer' }} title={CATEGORY_NAMES[c]}>
              <input type="checkbox" data-testid={`boundary-${c}`} checked={!excluded.includes(c)}
                onChange={(e) => setExcluded(e.target.checked ? excluded.filter((x) => x !== c) : [...excluded, c])} /> {c}
            </label>
          ))}
        </div>
      </div>
      <Status loading={loading} error={error} />
      {r && (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <Stat label="Scope 3 share of footprint" value={fmt.pct(r.scope3_share)} unit={r.scope3_target_required ? 'target required (C4)' : 'below 40%'} />
            <Stat label="Near-term coverage (C6 ≥ 67%)" value={<><Pill tone={r.rag}>{r.rag}</Pill> {fmt.pct(r.near_term_coverage)}</>} />
            <Stat label="Long-term coverage (≥ 90%)" value={fmt.pct(r.long_term_coverage)} unit={r.long_term_pass ? 'pass' : 'fail'} />
          </div>
          <div className="grid cols-2">
            <div className="card">
              <h2>Gates</h2>
              <table><tbody>
                <tr><td>C6 near-term coverage</td><td>{r.near_term_pass ? <Pill tone="green">pass</Pill> : <Pill tone="red">fail</Pill>}</td></tr>
                <tr><td>Net-zero long-term coverage</td><td>{r.long_term_pass ? <Pill tone="green">pass</Pill> : <Pill tone="red">fail</Pill>}</td></tr>
                <tr><td>C9 exclusions under 5%</td><td>{r.exclusion_pass ? <Pill tone="green">pass</Pill> : <Pill tone="red">fail</Pill>} <span className="muted">{fmt.pct(r.exclusion_share)}</span></td></tr>
                <tr><td>C22 category 11 target</td><td>{!r.category_11_mandatory ? <Pill tone="grey">n/a</Pill> : r.category_11_covered ? <Pill tone="green">covered</Pill> : <Pill tone="red">not covered</Pill>}</td></tr>
              </tbody></table>
            </div>
            <div className="card">
              <h2>{r.submission_ready ? 'Ready to submit' : 'What blocks a submission'}</h2>
              {r.blockers.length === 0 ? <p className="muted">Nothing.</p> : <ul className="blockers">{r.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
            </div>
          </div>
        </>
      )}
    </>
  )
}
