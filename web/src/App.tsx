import { useState } from 'react'
import { getOrg, setOrg } from './api'
import { useHashRoute } from './hooks'
import { CounterpartiesView } from './views/Counterparties'
import { CoverageView } from './views/Coverage'
import { DossierView } from './views/Dossier'
import { InventoryView } from './views/Inventory'
import { PlanView } from './views/Plan'
import { ReviewView } from './views/Review'

const ORGS = [
  { id: 'org_welcome_shaped', name: 'Welcome-shaped operator' },
  { id: 'org_other_client', name: 'Other client' },
]

const NAV = [
  ['/plan', 'Engagement plan'], ['/counterparties', 'Counterparties'], ['/inventory', 'Inventory'],
  ['/coverage', 'Target readiness'], ['/review', 'Review queue'],
] as const

export default function App() {
  const route = useHashRoute()
  const [org, setOrgState] = useState(getOrg())
  const period = 2026
  const section = '/' + route.split('/')[1]
  let view
  if (route.startsWith('/counterparties/')) view = <DossierView id={decodeURIComponent(route.split('/')[2])} period={period} />
  else if (section === '/counterparties') view = <CounterpartiesView period={period} />
  else if (section === '/inventory') view = <InventoryView period={period} />
  else if (section === '/coverage') view = <CoverageView period={period} />
  else if (section === '/review') view = <ReviewView />
  else view = <PlanView period={period} />
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand"><span className="dot" /> NZC AI · Scope 3</div>
        {NAV.map(([path, label]) => <a key={path} href={`#${path}`} className={section === path ? 'active' : ''}>{label}</a>)}
        <div className="org">
          Acting for
          <select value={org} onChange={(e) => { setOrg(e.target.value); setOrgState(e.target.value); window.location.reload() }}>
            {ORGS.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      </nav>
      <main className="main" key={org}>{view}</main>
    </div>
  )
}
