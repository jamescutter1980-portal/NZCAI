# Value chain: Scope 3 counterparties

The value chain module holds every upstream and downstream counterparty whose
emissions fall in the client's Scope 3, tracks each year's request for data
from the first ask to a verified figure, and records what came back. It is the
part of Scope 3 that a ledger cannot do: who holds the data, whether we have
asked, what they sent, and what to do next.

Routes: `/value-chain` (register, coverage, ranked plan), `/value-chain/[id]`
(one counterparty's dossier), `/api/value-chain/...`, `/api/exports/value-chain`.

## The register

A **counterparty** is a legal entity with a set of roles, because one company
is often several things at once: a franchisor that demands outlet data is also
a supplier of coffee. Roles are upstream or downstream and each implies the
Scope 3 categories the relationship serves; the categories can be overridden.

| Role | Direction | Category |
|---|---|---|
| supplier, capital_supplier, energy_supplier | upstream | 1, 2, 3 |
| distributor, logistics | upstream | 1 and 4, 4 |
| waste_contractor, travel_provider, landlord, franchisor | upstream | 5, 6, 8, 1 |
| outbound_logistics, processor | downstream | 9, 10 |
| customer, tenant, franchisee, investee | downstream | 11 and 12, 13, 14, 15 |

Each counterparty carries an annual value (spend with an upstream
counterparty, revenue from a downstream one), a day-to-day contact, an
escalation contact and a **minimum ask**. The annual value drives ranking and
the spend-share allocation; a counterparty without one is listed but cannot be
ranked, and the report says so.

Counterparties are added one at a time or imported from a supplier list, an
accounts-payable vendor export or a tenancy schedule with the generic CSV
importer; a row whose name matches an existing counterparty updates it.

## The ask

The minimum asked of every counterparty is an **annual GHG report**: Scope 1,
Scope 2 (location and, where reported, market), Scope 3, the organisational
boundary, the methodology, the assurance status, and either their revenue for
the period or the share of their emissions attributable to the client. A
counterparty with no report is asked for an **activity ledger**: one line per
activity and period (kWh, litres, km, tonne-km, tonnes) with the share of each
line done on the client's account, in a CSV template the portal reads back.

The dossier drafts the request text. Nothing is sent from the portal; the
consultant pastes it into their own mail. Set `CLIENT_NAME` in `.env.local`
for the client's name to appear in it.

## Engagement lifecycle

One engagement per counterparty per reporting year. The reporting year is the
year the selected period starts in, so FY 2025/26 keys on 2025.

```
identified → contacted → engaged → responding → complete → verified
                 ↓          ↓          ↓
            unreachable  declined   declined
```

Actions are recorded against the engagement: request sent (with the deadline
given), reminder sent, escalated, reply received, data received (partial or
complete), marked complete, verified, declined (with a reason, including the
Omnibus right of a sub-1,000-employee supplier to refuse anything beyond VSME),
unreachable, reopened, and a note. Every action writes an audit event with the
date, channel, detail and actor; the transition table in
`src/lib/value-chain/lifecycle.ts` refuses a move the state does not allow.

The **next action** is computed, not guessed, from the state, the dates and
what has arrived: send the request; wait inside 21 days of silence; reminder 1
and 2; escalate to the escalation contact; final notice; and, once the
deadline plus 14 days of grace has passed with nothing usable, fall back to a
secondary estimate and disclose it. The engagement plan on the register lists
every due action, overdue first and then by value.

## What comes back

### Annual report

The figures are recorded with the period they cover, the methodology, the
boundary, the assurance level and provider, the basis (sent to us, taken from
a public report, or estimated) and the evidence reference. The reported total
is Scope 1 + Scope 2 (market where reported, else location) + Scope 3 over the
figures supplied. The share attributed to the client follows the stated
allocation method:

| Method | Attributable figure | Tier |
|---|---|---|
| product_specific | the product or service footprint the counterparty stated | A |
| supplier_allocated | the share the counterparty stated as ours | A if assured, else B |
| spend_share | reported total × our annual value ÷ their revenue | B |
| supplier_total | the whole reported footprint (a dedicated supplier or wholly-leased asset) | B |
| any, basis estimated | as above | E |

A spend share whose value exceeds the counterparty's revenue is refused with
the reason rather than capped. A report whose period does not overlap the
selected reporting period is flagged. Warnings say when Scope 2 or Scope 3 is
absent from the total and when a counterparty's Scope 3 could include
downstream emissions the client reports elsewhere.

### Activity ledger

Each line is converted on the same contract as the transport and emissions
modules: a chosen DESNZ row, the unit checked against the row's unit, the
line's share applied. A line with no factor row uses the kgCO2e the
counterparty declared (tier B); a line with a factor is tier C; an estimated
line is tier E; a line with neither a factor nor a declared figure is null and
blanks the ledger total. Where the counterparty declared a figure and a factor
is also chosen, a variance above 10% is reported and the factor figure used.

Where both a report and a ledger exist for the year the report is used and
the variance between the two is shown; above 25% it is raised as a warning.

### Spend-based fallback (tier D)

A counterparty may carry a sector spend factor in kgCO2e per £ with its
source (publication, sector and year). While no report or ledger is held for
the year, annual value × factor stands in as a **tier D estimate**. It is
shown and exported as an estimate, counted separately from returned data in
the totals, never lifts the primary share, never counts as "data returned",
and never stops the chase. The moment a report or ledger arrives it is
dropped. A factor without a source is refused.

## Companies House

"Find on Companies House" on the dossier searches the register for the
counterparty's name and lists the candidates; picking one fills the company
number, the sector from the SIC codes where none is recorded, and the country.
The recorded name is kept, a differing register name is reported, and a
company the register shows as dissolved or in liquidation is flagged. Needs
`COMPANIES_HOUSE_API_KEY`; nothing is applied without the pick.

## Waves

On the register, select counterparties (or "select not yet asked") and record
one action for all of them: request sent with a deadline, a reminder, an
escalation, a decline. Each counterparty is handled on its own: a transition
its state does not allow is skipped with the reason and the rest go through,
and every applied transition writes its audit event.

## Requests in: the inbox

Traffic runs both ways. A franchisor asks for outlet energy, a parent asks
for category-level figures for its CSRD consolidation, a lender or a landlord
asks for a return. `/value-chain/inbox` holds each as a work item: the
requester (a counterparty with its role), the fields they ask for in their
own wording, the reporting year and period basis (calendar or financial),
the deadline, the owner, and whether it recurs.

Each field maps to a **metric the portal can answer** from its own modules:
energy and floor area from the portfolio roll-up; Scope 1 (gas, own vehicles,
refrigerants), Scope 2 location and market, and category 3 losses; business
travel, commuting and all transport Scope 3; refrigerants, waste tonnage and
diversion, water; and the counterparties' attributable Scope 3 and its
primary-data share. A field with no portal source is entered by hand. The
draft response shows every value with the module it came from and what it
covers; a value the portal cannot compute is blank with the reason, never
zero. A hand-entered value on a computed metric is allowed but flagged and
needs a note.

**Consistency guard.** Before submission every figure is compared with what
was already submitted for the same metric and year to any other requester.
A difference above 0.5% is a conflict, shown with who received the earlier
figure and when. Submission is blocked until the conflict is resolved or a
note records why the figures differ; the note travels with the submission.

**Submission** snapshots the figures as sent, so what a requester received
is on record even after the underlying data changes. An annual request
**rolls forward** to the next year with the same template and fields, with
last year's hand-entered values cleared. The inbox flags what is overdue,
what is due within thirty days, and which annual requests have not yet been
rolled forward.

## Coverage and totals

The report for a period gives: counterparties by direction; how many were
asked, returned data, were verified, declined or could not be reached; the
share of annual value backed by returned data; the attributable tCO2e (null if
any counterparty with data cannot be resolved), split into returned data and
tier D spend estimates; the primary-data share (tiers A and B) for the ESRS
E1-6 split; totals by direction, by Scope 3 category
(a counterparty serving several categories is listed under "several", not
split) and by tier.

Two readiness checks in the Scope coverage group follow from it: whether
every active counterparty has been asked and none is overdue, and whether
every one has returned data. Both name the counterparties concerned, most
valuable first.

## House rules

- Numbers come from the engine in `src/lib/value-chain/report.ts`; nothing
  on a page or in an export is typed in as a total.
- A figure that cannot be computed is null with the reason. A total holding
  a null is null. Nothing is ever reported as zero for want of data.
- The allocation basis, tier, assurance and evidence travel with every figure
  into the export.
- Every engagement transition writes an audit row.

## Not yet built

Public-report harvesting and pre-filled requests, sending mail, and PACT or
VSME machine exchange. The brief in the product
docs covers each; this module is the graph, lifecycle and evidence layer they
attach to.
