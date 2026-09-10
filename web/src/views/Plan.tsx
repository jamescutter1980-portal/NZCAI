import { api, fmt } from '../api'
import { navigate, useLoad } from '../hooks'
import { Pill, StatePill, Stat, Status } from '../components/bits'

const ROUTE_TONE: Record<string, string> = { engage_direct: 'green', accept_published: 'grey', negotiate_at_renewal: 'amber', use_secondary: 'red' }

export function PlanView({ period }: { period: number }) {
  const { data, error, loading } = useLoad(() => api.plan(period), [period])
  return (
    <>
      <h1>Engagement plan · {period}</h1>
      <p className="sub">Ranked by what a response would improve, how likely one is, and what leverage exists. Dominant counterparties are aligned to, not chased.</p>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <Stat label="Uplift available" value={fmt.t(data.total_uplift_tco2e)} unit="tCO₂e" />
            <Stat label="Primary share now" value={data.trajectory ? fmt.pct(data.trajectory.current_primary_share) : '—'} />
            <Stat label="Primary share if the plan lands" value={data.trajectory ? fmt.pct(data.trajectory.achievable_primary_share) : '—'} />
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Tier</th><th>Counterparty</th><th className="num">Uplift t</th><th className="num">Win</th><th className="num">Lev.</th><th>Route</th><th>Ask in</th><th>State</th><th>Next step</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.counterparty.id} className="clickable" onClick={() => navigate(`/counterparties/${r.counterparty.id}`)} data-testid="plan-row">
                    <td><Pill tone={r.tier === 'T1' ? 'green' : r.tier === 'T2' ? 'amber' : 'grey'} mono>{r.tier ?? '—'}</Pill></td>
                    <td><strong>{r.counterparty.name}</strong></td>
                    <td className="num">{fmt.t(r.score.uplift_tco2e)}</td>
                    <td className="num">{r.score.winnability.toFixed(2)}</td>
                    <td className="num">{r.score.leverage.toFixed(2)}</td>
                    <td><Pill tone={ROUTE_TONE[r.score.route]}>{r.score.route.replace(/_/g, ' ')}</Pill></td>
                    <td><Pill tone="grey" mono>{r.template.toUpperCase()}</Pill></td>
                    <td>{r.engagement ? <StatePill state={r.engagement.state} /> : <span className="muted">—</span>}</td>
                    <td>{r.next_step ? <>{fmt.date(r.next_step.due)} <span className="muted">· {r.next_step.rung.replace(/_/g, ' ')}</span></> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
