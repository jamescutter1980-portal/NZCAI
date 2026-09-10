import type { ReactNode } from 'react'
import { CATEGORY_NAMES, fmt } from '../api'

export const Pill = ({ tone, children, mono }: { tone?: string; children: ReactNode; mono?: boolean }) => (
  <span className={`pill ${tone ?? ''} ${mono ? 'mono' : ''}`}>{children}</span>
)

export const TierPill = ({ tier }: { tier: string | null }) =>
  tier ? <span className={`pill mono tier-${tier}`}>{tier}</span> : <span className="muted">—</span>

export const StatePill = ({ state }: { state: string }) => {
  const tone = ['verified', 'complete'].includes(state) ? 'green'
    : ['declined', 'unreachable', 'lapsed'].includes(state) ? 'red'
    : ['contacted', 'engaged', 'responding', 'partial'].includes(state) ? 'amber' : 'grey'
  return <Pill tone={tone}>{state.replace(/_/g, ' ')}</Pill>
}

export const Stat = ({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) => (
  <div className="card stat">
    <span className="label">{label}</span>
    <span className="value">{value}{unit && <small> {unit}</small>}</span>
  </div>
)

export const Bar = ({ share }: { share: number }) => (
  <div className="bar" title={fmt.pct(share)}><span style={{ width: `${Math.min(100, share * 100)}%` }} /></div>
)

export const Cat = ({ id }: { id: string }) => <>
  <span className="pill mono grey">{id}</span> {CATEGORY_NAMES[id] ?? ''}
</>

export const Status = ({ loading, error }: { loading: boolean; error: string | null }) => {
  if (error) return <div className="error">Could not load: {error}</div>
  if (loading) return <p className="muted">Loading…</p>
  return null
}
