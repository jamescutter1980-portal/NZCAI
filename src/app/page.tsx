import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1>NZC Portal</h1>
      <p>Integration modules. See docs/data-source-roadmap.md for the full plan.</p>
      <ul>
        <li>
          <Link href="/lookup">Location lookup</Link> – every location check for a postcode or point in one click, nothing saved
        </li>
        <li>
          <Link href="/transport">Transport and travel</Link> – fleet, grey fleet, business travel and commuting with DESNZ factors
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
