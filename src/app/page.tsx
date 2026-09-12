import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1>NZC Portal</h1>
      <p>Integration modules. See docs/data-source-roadmap.md for the full plan.</p>
      <ul>
        <li>
          <Link href="/readiness">Reporting readiness</Link> – what is still missing before a return can be filed
        </li>
        <li>
          <Link href="/lookup">Location lookup</Link> – every location check for a postcode or point in one click, nothing saved
        </li>
        <li>
          <Link href="/transport">Transport and travel</Link> – fleet, grey fleet, business travel and commuting with DESNZ factors
        </li>
        <li>
          <Link href="/emissions">Refrigerants, water and waste</Link> – Scope 1 fugitive and the Scope 3 sources meters do not cover
        </li>
        <li>
          <Link href="/value-chain">Value chain</Link> – upstream and downstream counterparties, each year&apos;s data request and its audit trail, and the emissions they return
        </li>
        <li>
          <Link href="/value-chain/inbox">Requests in</Link> – data requests from franchisors, customers, parents and lenders, answered from the portal&apos;s own figures with a consistency guard
        </li>
        <li>
          <Link href="/value-chain/hotspots">Scope 3 hotspots</Link> – which counterparties carry the emissions, so engagement effort goes where it counts
        </li>
        <li>
          <Link href="/value-chain/completeness">Scope 3 completeness</Link> – all fifteen categories assessed, each exclusion justified
        </li>
        <li>
          <Link href="/value-chain/trend">Scope 3 year on year</Link> – headline change against like-for-like, so a change of register does not read as abatement
        </li>
        <li>
          <Link href="/value-chain/targets">Scope 3 targets</Link> – progress against a straight-line trajectory and the abatement pipeline behind the gap
        </li>
        <li>
          <Link href="/portfolio">Portfolio</Link> – energy, carbon and data quality across every asset for any reporting period
        </li>
        <li>
          <Link href="/assets">Assets</Link> – buildings with linked meters, energy and carbon by year, one-click environmental screening
        </li>
        <li>
          <Link href="/sources">Data sources</Link> – every external API and dataset: status, configuration, health checks and lookups
        </li>
        <li>
          <Link href="/meters/n3rgy">n3rgy smart-meter data</Link> – consent-based half-hourly electricity and gas
        </li>
        <li>
          <Link href="/consents">Meter data consents</Link> – record, verify, renew and withdraw occupier consents
        </li>
        <li>
          <Link href="/sync">n3rgy sync</Link> – scheduled pull of readings and tariffs into the portal database
        </li>
        <li>
          <Link href="/readings">Stored readings</Link> – daily totals, gaps and indicative cost per meter
        </li>
      </ul>
    </>
  );
}
