import { api, fmt } from '../api'
import { navigate, useLoad } from '../hooks'
import { Pill, StatePill, Status } from '../components/bits'

export function CounterpartiesView({ period }: { period: number }) {
  const { data, error, loading } = useLoad(() => api.counterparties(period), [period])
  return (
    <>
      <h1>Counterparties · {period}</h1>
      <p className="sub">Every legal entity in the value chain, with the tonnes attributed to it and where the engagement stands.</p>
      <Status loading={loading} error={error} />
      {data && (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Roles</th><th className="num">tCO₂e</th><th>Engagement</th><th>Position</th></tr></thead>
            <tbody>
              {data.counterparties.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/counterparties/${c.id}`)} data-testid="counterparty-row">
                  <td><strong>{c.name}</strong><br /><span className="muted">{c.company_number ?? 'no company number'}</span></td>
                  <td>{c.roles.map((r) => <Pill key={r} tone="grey">{r.replace(/_/g, ' ')}</Pill>)}</td>
                  <td className="num">{fmt.t(c.tco2e)}</td>
                  <td>{c.engagement ? <StatePill state={c.engagement.state} /> : <span className="muted">none</span>}</td>
                  <td>
                    {c.is_dominant && <Pill tone="amber">dominant</Pill>}{' '}
                    {c.spans_value_chain && <Pill tone="grey">up and down</Pill>}{' '}
                    {!c.may_be_asked_beyond_vsme && <Pill tone="grey">VSME cap</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
