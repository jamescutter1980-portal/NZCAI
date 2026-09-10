// Thin client over api/handlers.py. The organisation travels as a header in
// the local adapter; a hosted deployment replaces this with the session.

export type Tier = 'A' | 'B' | 'C' | 'D' | 'E'

export interface Figure {
  id: number
  status: string
  category: string
  tco2e: number
  tier: Tier
  factor_source: string
  factor_version: string
  counterparty_id: string | null
  document_id: string | null
  achievable_tier: Tier | null
  entity_id: string | null
  activity_quantity: number | null
  activity_unit: string | null
  factor_key: string | null
  factor_kgco2e: number | null
  method_label: string | null
  has_lineage: boolean
}

export interface CategoryQuality {
  category: string
  total_tco2e: number
  primary_tco2e: number
  secondary_tco2e: number
  primary_share: number
  weighted_dq_score: number
  tier_breakdown: Record<string, number>
}

export interface Trajectory {
  current_primary_share: number
  achievable_primary_share: number
  current_dq_score: number
  achievable_dq_score: number
  uplift_tco2e: number
  share_gain: number
}

export interface Inventory {
  period: number
  total_tco2e: number
  primary_share: number
  weighted_dq_score: number
  trajectory: Trajectory | null
  categories: CategoryQuality[]
  figures: Figure[]
}

export interface Counterparty {
  id: string
  name: string
  roles: string[]
  company_number: string | null
  employee_band: number | null
  turnover_gbp: number | null
  has_public_report: boolean
  is_cdp_responder: boolean
  has_validated_target: boolean
  has_named_contact: boolean
  responded_before: boolean
  contractual_data_right: boolean
  emissions_intensive_commodity: string | null
  contract_end: string | null
  is_dominant: boolean
  spans_value_chain: boolean
  may_be_asked_beyond_vsme: boolean
}

export interface Engagement {
  id: string
  counterparty_id: string
  period: number
  state: string
  entered_at: string | null
  deadline: string | null
  decline_reason: string | null
  contact_attempts: number
}

export interface AuditRow {
  engagement_id: string
  from_state: string
  to_state: string
  actor: string
  trigger: string
  at: string
  evidence_id: string | null
}

export interface Score {
  counterparty_id: string
  uplift_tco2e: number
  winnability: number
  leverage: number
  score: number
  route: string
  reason: string
}

export interface Step {
  due: string
  weeks_before: number
  rung: string
  action: string
  is_fallback: boolean
}

export interface Document {
  id: string
  counterparty_id: string
  doc_type: string
  issue_date: string
  confidentiality: string
  period_covered: number | null
  valid_to: string | null
  owner_org_id: string | null
  consented_org_ids: string[]
  sha256: string | null
}

export interface CounterpartyRow extends Counterparty {
  tco2e: number
  engagement: Engagement | null
  open: boolean
}

export interface Dossier {
  counterparty: Counterparty
  figures: Figure[]
  tco2e: number
  uplift_tco2e: number
  score: Score
  template: string
  engagements: Engagement[]
  audit: Record<string, AuditRow[]>
  documents: Document[]
}

export interface PlanRow {
  counterparty: Counterparty
  score: Score
  tier: string | null
  template: string
  engagement: Engagement | null
  next_step: Step | null
}

export interface Plan {
  period: number
  rows: PlanRow[]
  total_uplift_tco2e: number
  trajectory: Trajectory | null
}

export interface CoverageResult {
  scope3_share: number
  scope3_target_required: boolean
  near_term_coverage: number
  near_term_pass: boolean
  long_term_coverage: number
  long_term_pass: boolean
  exclusion_share: number
  exclusion_pass: boolean
  category_11_mandatory: boolean
  category_11_covered: boolean
  rag: 'green' | 'amber' | 'red'
  blockers: string[]
  submission_ready: boolean
}

export interface Proposal {
  id: number
  agent: string
  kind: string
  payload: Record<string, unknown>
  confidence: number | null
  status: string
  decided_by: string | null
  created_at: string
}

export interface Conflict {
  id: number
  conflict_class: string
  subject: string
  value_a: string
  source_a: string
  value_b: string
  source_b: string
  proposed_resolution: string
  rationale: string
}

export interface LineageRow {
  id: number
  status: string
  supersedes_id: number | null
  tco2e: number
  tier: Tier
  category: string
  factor_source: string
  factor_version: string
  factor_key: string | null
  factor_kgco2e: number | null
  activity_quantity: number | null
  activity_unit: string | null
  method_label: string | null
  document_id: string | null
  created_by: string | null
  created_at: string
  document: Document | null
}

let orgId = localStorage.getItem('nzc.org') ?? 'org_welcome_shaped'
export const getOrg = () => orgId
export const setOrg = (id: string) => { orgId = id; localStorage.setItem('nzc.org', id) }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': orgId, 'X-Actor': 'portal-user' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await r.json().catch(() => ({}))
  if (!r.ok && r.status !== 207) throw new ApiError(r.status, payload.error ?? r.statusText)
  return payload as T
}

const q = (params: Record<string, string | number | boolean | undefined>) =>
  '?' + Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')

export const api = {
  inventory: (period: number) => call<Inventory>('GET', `/api/inventory${q({ period })}`),
  lineage: (id: number) => call<{ chain: LineageRow[] }>('GET', `/api/figures/${id}/lineage`),
  coverage: (p: { period: number; scope1: number; scope2: number; sells_fossil_fuel: boolean; covered?: string }) =>
    call<{ result: CoverageResult; covered: string[] }>('GET', `/api/coverage${q(p)}`),
  counterparties: (period: number) => call<{ counterparties: CounterpartyRow[] }>('GET', `/api/counterparties${q({ period })}`),
  dossier: (id: string, period: number) => call<Dossier>('GET', `/api/counterparties/${encodeURIComponent(id)}${q({ period })}`),
  plan: (period: number) => call<Plan>('GET', `/api/plan${q({ period })}`),
  engagement: (id: string) => call<{ engagement: Engagement; schedule: Step[]; next_step: Step | null; audit: AuditRow[] }>('GET', `/api/engagements/${encodeURIComponent(id)}`),
  transition: (id: string, body: { to: string; trigger?: string; decline_reason?: string; evidence_id?: string }) =>
    call<{ engagement: Engagement; audit_row: AuditRow }>('POST', `/api/engagements/${encodeURIComponent(id)}/transition`, body),
  documents: (counterparty_id?: string) => call<{ documents: Document[] }>('GET', `/api/documents${q({ counterparty_id })}`),
  review: () => call<{ proposals: Proposal[]; conflicts: Conflict[] }>('GET', '/api/review'),
  decideProposal: (id: number, accept: boolean) => call<Proposal>('POST', `/api/review/proposals/${id}`, { accept }),
  decideConflict: (id: number, decision: string) => call<unknown>('POST', `/api/review/conflicts/${id}`, { decision }),
}

export const fmt = {
  t: (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: n >= 100 ? 0 : 1 }),
  pct: (x: number) => `${(x * 100).toFixed(x >= 0.995 ? 0 : 1)}%`,
  gbp: (n: number) => n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }),
  date: (s: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
}

export const CATEGORY_NAMES: Record<string, string> = {
  '1': 'Purchased goods and services', '2': 'Capital goods', '3': 'Fuel and energy related', '4': 'Upstream transport',
  '5': 'Waste in operations', '6': 'Business travel', '7': 'Employee commuting', '8': 'Upstream leased assets',
  '9': 'Downstream transport', '10': 'Processing of sold products', '11': 'Use of sold products',
  '12': 'End-of-life of sold products', '13': 'Downstream leased assets', '14': 'Franchises', '15': 'Investments',
}
