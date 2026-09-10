import { api, fmt } from '../api'
import { useLoad } from '../hooks'
import { Status, TierPill } from './bits'

// The lineage drawer answers the assurance question: where did this number
// come from, what factor, what document, and what did it replace.
export function LineageDrawer({ figureId, onClose }: { figureId: number; onClose: () => void }) {
  const { data, error, loading } = useLoad(() => api.lineage(figureId), [figureId])
  return (
    <aside className="drawer" role="dialog" aria-label="Figure lineage">
      <button className="btn secondary close" onClick={onClose}>Close</button>
      <h2>Lineage of figure #{figureId}</h2>
      <Status loading={loading} error={error} />
      {data && (
        <div className="chain">
          {data.chain.map((row, i) => (
            <div className="step" key={row.id}>
              <div>
                <strong>#{row.id}</strong> {row.status === 'superseded' ? <span className="pill red">superseded</span> : <span className="pill green">active</span>}
                {i < data.chain.length - 1 && <span className="muted"> → replaced by #{data.chain[i + 1].id}</span>}
              </div>
              <dl className="kv">
                <dt>tCO₂e</dt><dd>{fmt.t(row.tco2e)}</dd>
                <dt>Method tier</dt><dd><TierPill tier={row.tier} /></dd>
                <dt>Factor</dt><dd>{row.factor_source} · {row.factor_version}</dd>
                {row.factor_key && <><dt>Factor row</dt><dd>{row.factor_key} = {row.factor_kgco2e} kgCO₂e/{row.activity_unit}</dd></>}
                {row.activity_quantity != null && <><dt>Activity</dt><dd>{fmt.t(row.activity_quantity)} {row.activity_unit}</dd></>}
                {row.method_label && <><dt>Method</dt><dd>{row.method_label}</dd></>}
                <dt>Evidence</dt>
                <dd>{row.document ? `${row.document.doc_type} · ${row.document.id} · issued ${fmt.date(row.document.issue_date)}` : row.document_id ?? 'none attached'}</dd>
                {row.document?.sha256 && <><dt>SHA-256</dt><dd>{row.document.sha256.slice(0, 16)}…</dd></>}
                <dt>Recorded</dt><dd>{row.created_by ?? 'engine'} · {row.created_at}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
