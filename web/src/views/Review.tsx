import { useState } from 'react'
import { api } from '../api'
import { useLoad } from '../hooks'
import { Pill, Status } from '../components/bits'

// The review queue is where agents stop and people start. Nothing in it
// has changed a figure or left the building.
export function ReviewView() {
  const { data, error, loading, reload } = useLoad(() => api.review(), [])
  const [busy, setBusy] = useState<number | null>(null)
  const decide = async (id: number, accept: boolean) => {
    setBusy(id)
    try { await api.decideProposal(id, accept); reload() } finally { setBusy(null) }
  }
  const resolve = async (id: number, decision: string) => {
    setBusy(id)
    try { await api.decideConflict(id, decision); reload() } finally { setBusy(null) }
  }
  return (
    <>
      <h1>Review queue</h1>
      <p className="sub">Agents propose. A person decides. Every decision is recorded with who made it.</p>
      <Status loading={loading} error={error} />
      {data && (
        <div className="grid cols-2">
          <div className="card">
            <h2>Proposals ({data.proposals.length})</h2>
            {data.proposals.length === 0 && <p className="muted">Nothing waiting.</p>}
            {data.proposals.map((p) => (
              <div key={p.id} style={{ borderBottom: '1px solid var(--line)', padding: '10px 0' }} data-testid="proposal">
                <div><Pill tone="grey">{p.agent}</Pill> <Pill tone="amber">{p.kind.replace(/_/g, ' ')}</Pill> {p.confidence != null && <span className="muted">confidence {(p.confidence * 100).toFixed(0)}%</span>}</div>
                <pre>{JSON.stringify(p.payload, null, 1)}</pre>
                <div className="actions">
                  <button className="btn" disabled={busy === p.id} onClick={() => decide(p.id, true)}>Accept</button>
                  <button className="btn danger" disabled={busy === p.id} onClick={() => decide(p.id, false)}>Reject</button>
                </div>
              </div>
            ))}
          </div>
          <div className="card">
            <h2>Conflicts ({data.conflicts.length})</h2>
            {data.conflicts.length === 0 && <p className="muted">Nothing open.</p>}
            {data.conflicts.map((c) => (
              <div key={c.id} style={{ borderBottom: '1px solid var(--line)', padding: '10px 0' }} data-testid="conflict">
                <div><Pill tone="red">{c.conflict_class.replace(/_/g, ' ')}</Pill> <strong>{c.subject}</strong></div>
                <dl className="kv" style={{ marginTop: 6 }}>
                  <dt>{c.source_a}</dt><dd>{c.value_a}</dd>
                  <dt>{c.source_b}</dt><dd>{c.value_b}</dd>
                  <dt>Proposed</dt><dd style={{ fontFamily: 'var(--font)' }}>{c.proposed_resolution}</dd>
                  <dt>Because</dt><dd style={{ fontFamily: 'var(--font)' }}>{c.rationale}</dd>
                </dl>
                <div className="actions" style={{ marginTop: 8 }}>
                  <button className="btn" disabled={busy === c.id} onClick={() => resolve(c.id, c.proposed_resolution)}>Accept proposal</button>
                  <button className="btn secondary" disabled={busy === c.id} onClick={() => { const d = window.prompt('Decision'); if (d) resolve(c.id, d) }}>Decide otherwise</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
