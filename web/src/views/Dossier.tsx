import { useState } from 'react'
import { api, fmt, type Engagement } from '../api'
import { useLoad } from '../hooks'
import { Cat, Pill, StatePill, Stat, Status, TierPill } from '../components/bits'
import { LineageDrawer } from '../components/LineageDrawer'

const NEXT: Record<string, string[]> = {
  unidentified: ['identified'], identified: ['enriched', 'unreachable'], enriched: ['scoped'],
  scoped: ['contacted', 'complete'], contacted: ['contacted', 'engaged', 'partial', 'declined', 'unreachable'],
  engaged: ['responding', 'declined'], responding: ['partial', 'complete', 'declined'],
  partial: ['partial', 'complete', 'declined'], complete: ['verified', 'partial'], verified: ['lapsed', 'superseded'],
  declined: ['contacted'], unreachable: ['identified'], lapsed: ['contacted'], superseded: [],
}

function EngagementCard({ e, onChange }: { e: Engagement; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { data } = useLoad(() => api.engagement(e.id), [e.id, e.state])
  const move = async (to: string) => {
    setBusy(true); setErr(null)
    try {
      const body: { to: string; trigger: string; decline_reason?: string } = { to, trigger: 'portal' }
      if (to === 'declined') {
        const reason = window.prompt('Decline reason: vsme_cap, no_capability, commercial_sensitivity, no_response, other')
        if (!reason) { setBusy(false); return }
        body.decline_reason = reason
      }
      await api.transition(e.id, body)
      onChange()
    } catch (x) { setErr(String((x as Error).message)) } finally { setBusy(false) }
  }
  return (
    <div className="card" data-testid="engagement-card">
      <h2>Engagement {e.id} · <StatePill state={e.state} /></h2>
      <dl className="kv">
        <dt>Period</dt><dd>{e.period}</dd>
        <dt>Deadline</dt><dd>{fmt.date(e.deadline)}</dd>
        <dt>Contact attempts</dt><dd>{e.contact_attempts}</dd>
        {e.decline_reason && <><dt>Declined because</dt><dd>{e.decline_reason}</dd></>}
        {data?.next_step && <><dt>Next step</dt><dd>{fmt.date(data.next_step.due)} · {data.next_step.rung.replace(/_/g, ' ')} · {data.next_step.action}</dd></>}
      </dl>
      <div className="actions" style={{ marginTop: 10 }}>
        {(NEXT[e.state] ?? []).map((to) => (
          <button key={to} className={`btn ${['declined', 'unreachable', 'lapsed'].includes(to) ? 'danger' : 'secondary'}`} disabled={busy} onClick={() => move(to)}>
            → {to}
          </button>
        ))}
      </div>
      {err && <p className="error" style={{ marginTop: 8 }}>{err}</p>}
      {data && data.audit.length > 0 && (
        <>
          <h2 style={{ marginTop: 14 }}>Audit trail</h2>
          <ul className="timeline">
            {data.audit.map((a, i) => (
              <li key={i}><span className="when">{fmt.date(a.at)}</span><span>{a.from_state} → <strong>{a.to_state}</strong> · {a.actor} · {a.trigger}{a.evidence_id && ` · ${a.evidence_id}`}</span></li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export function DossierView({ id, period }: { id: string; period: number }) {
  const { data, error, loading, reload } = useLoad(() => api.dossier(id, period), [id, period])
  const [open, setOpen] = useState<number | null>(null)
  return (
    <>
      <Status loading={loading} error={error} />
      {data && (
        <>
          <h1>{data.counterparty.name}</h1>
          <p className="sub">
            {data.counterparty.roles.map((r) => <Pill key={r} tone="grey">{r.replace(/_/g, ' ')}</Pill>)}{' '}
            {data.counterparty.is_dominant && <Pill tone="amber">dominant: we do not chase, we align</Pill>}{' '}
            {!data.counterparty.may_be_asked_beyond_vsme && <Pill tone="grey">may decline beyond VSME</Pill>}
          </p>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <Stat label="Attributed" value={fmt.t(data.tco2e)} unit="tCO₂e" />
            <Stat label="Uplift if they respond" value={fmt.t(data.uplift_tco2e)} unit="tCO₂e" />
            <Stat label="Route" value={<span style={{ fontSize: 16 }}>{data.score.route.replace(/_/g, ' ')}</span>} unit={`ask in ${data.template.toUpperCase()}`} />
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>Why this route</h2>
            <p>{data.score.reason}</p>
            <dl className="kv">
              <dt>Winnability</dt><dd>{data.score.winnability.toFixed(2)}</dd>
              <dt>Leverage</dt><dd>{data.score.leverage.toFixed(2)}</dd>
              <dt>Score</dt><dd>{fmt.t(data.score.score)}</dd>
            </dl>
          </div>
          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            {data.engagements.map((e) => <EngagementCard key={e.id} e={e} onChange={reload} />)}
            <div className="card">
              <h2>Documents we may see</h2>
              {data.documents.length === 0 ? <p className="muted">None held.</p> : (
                <table>
                  <thead><tr><th>Type</th><th>Issued</th><th>Valid to</th><th>Basis</th></tr></thead>
                  <tbody>{data.documents.map((d) => (
                    <tr key={d.id}><td>{d.doc_type.replace(/_/g, ' ')}<br /><span className="muted">{d.id}</span></td><td>{fmt.date(d.issue_date)}</td><td>{fmt.date(d.valid_to)}</td><td><Pill tone={d.confidentiality === 'public' ? 'green' : 'grey'}>{d.confidentiality.replace(/_/g, ' ')}</Pill></td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </div>
          <div className="card">
            <h2>Figures</h2>
            {data.figures.length === 0 ? <p className="muted">No figures attributed.</p> : (
              <table>
                <thead><tr><th>#</th><th>Category</th><th className="num">tCO₂e</th><th>Tier</th><th>Achievable</th><th>Method</th></tr></thead>
                <tbody>{data.figures.map((f) => (
                  <tr key={f.id} className="clickable" onClick={() => setOpen(f.id)}>
                    <td className="num">{f.id}</td><td><Cat id={f.category} /></td><td className="num">{fmt.t(f.tco2e)}</td>
                    <td><TierPill tier={f.tier} /></td><td><TierPill tier={f.achievable_tier} /></td><td>{f.method_label ?? f.factor_source}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      )}
      {open !== null && <LineageDrawer figureId={open} onClose={() => setOpen(null)} />}
    </>
  )
}
