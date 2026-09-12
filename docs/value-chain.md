# Value chain: Scope 3 counterparties

The value chain module holds every upstream and downstream counterparty whose
emissions fall in the client's Scope 3, tracks each year's request for data
from the first ask to a verified figure, and records what came back. It is the
part of Scope 3 that a ledger cannot do: who holds the data, whether we have
asked, what they sent, and what to do next.

Routes: `/value-chain` (register, coverage, ranked plan), `/value-chain/[id]`
(one counterparty's dossier), `/value-chain/inbox` (requests in),
`/value-chain/trend`, `/value-chain/completeness`, `/value-chain/hotspots`,
`/value-chain/targets`, `/value-chain/submit/[token]` (the counterparty's own
page), `/api/value-chain/...`, `/api/exports/value-chain`.

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

## Year on year: what actually changed

`/value-chain/trend`, `/api/value-chain/trend`, `src/lib/value-chain/trend.ts`.

A fall in reported Scope 3 is usually not abatement. Counterparties join and
leave the register, a tier D spend estimate gets replaced by a supplier's own
report, a period is restated. The trend engine therefore reports two numbers
for every pair of years:

- **Headline change** – this year's total against last year's, as filed.
- **Like-for-like change** – the same, counting only counterparties present in
  both years whose measurement basis did not change.

Every counterparty in a pair lands in exactly one bucket: `moved` (same basis,
so the movement is real), `rebased` (the data source or the tier changed, so
the movement is measurement, not abatement), `joined`, or `left`. A total that
is null in either year makes that year's change null, with the reason, rather
than an invented zero.

A **baseline** year can be set and **restatements** recorded against it, each
with a reason (`register_change`, `method_change`, `error_correction`,
`boundary_change`, `factor_update`) and a note. A trend with no baseline is
still reported, with a warning that no baseline is set.

## Category completeness: the fifteen categories

`/value-chain/completeness`, `/api/value-chain/completeness`,
`src/lib/value-chain/completeness.ts`.

GHG Protocol asks for all fifteen Scope 3 categories to be addressed, not all
fifteen to be reported. Each category, per reporting year, is assessed as
`relevant`, `not_relevant` or `unknown`, and separately as included or
excluded, with a justification.

The rules the schema enforces:

- A category judged `not_relevant` must be excluded — you cannot half-hold it.
- A category judged `relevant` cannot be excluded without a justification.
- A justification shorter than twenty characters is flagged as thin; "n/a" is
  not an exclusion.
- A category excluded while counterparties are registered against it is
  flagged: the register contradicts the assessment.

Assessments roll forward to the next year so only what changed is re-entered.
The readiness suite gained a third value-chain check,
`scope.s3_category_completeness`, which names the categories still unassessed
or excluded without a reason.

## Hotspots: where to spend the engagement effort

`/value-chain/hotspots`, `/api/value-chain/hotspots`,
`src/lib/value-chain/hotspots.ts`.

A register of two hundred counterparties cannot be chased evenly. The screen
ranks every counterparty on returned data where it exists and on a **screening
estimate** from spend where it does not, and marks the ones inside a cumulative
share threshold (80 % by default) as priority.

The screening estimate is for prioritisation only. It never enters a reported
total: the report engine remains the only source of filed figures, and the
screen says for each row which of the two it ranked on. A counterparty that can
be placed on neither — no returned data and no annual value — is not silently
dropped to the bottom; it goes to `unscreenable` with the reason, because an
unranked counterparty is a gap in the screen, not a small one.

## Targets and abatement pipeline

`/value-chain/targets`, `/api/value-chain/targets`,
`/api/value-chain/initiatives`, `src/lib/value-chain/targets.ts`.

A target is a baseline year and value, a target year and value, and a kind:
absolute tCO2e, intensity per £m of value, supplier engagement (share of spend
covered by counterparties with their own targets) or primary-data share. The
engine puts the latest year against a **straight-line trajectory** from the
baseline to the target and says whether it is on track, by how much, and what
remains.

Against the remaining gap sits the **abatement pipeline**: initiatives with a
lever (supplier switch, specification change, volume reduction, logistics,
circularity, supplier decarbonisation), an expected annual saving, a status,
and — once delivered — an achieved saving, which is required before an
initiative may be marked delivered.

The pipeline is never netted off measured emissions. It is reported beside the
gap, with the shortfall stated plainly: a pipeline of 120 tCO2e against a
250 tCO2e gap leaves 130 tCO2e with nothing behind it. Expected and achieved
savings are kept apart, so a pipeline that has never delivered cannot read as
progress.

## Supplier submissions: letting them send it themselves

`/value-chain/submit/[token]`, `/api/value-chain/submit/[token]`,
`/api/value-chain/submissions`, `src/lib/value-chain/submissions.ts`.

Chasing a counterparty by mail and re-keying the reply is the slowest part of
the cycle. The dossier can issue a **one-time link** for a counterparty and
year: 32 random bytes, stored only as a SHA-256 hash with a short hint for the
consultant to recognise, compared in constant time, with an expiry.

The link opens a single page showing who is asking, for what year and what is
needed; the counterparty fills in the annual report fields and submits. It is
the only unauthenticated path in the portal — `src/proxy.ts` opens exactly the
two submission paths, only when a token segment of at least sixteen characters
is present, so `/value-chain/submit` on its own stays behind the password — and
it reveals nothing without a valid token. An unknown token is a 404; an
expired, revoked or already-spent one is a 410.

What arrives is **held for review**. A submission is a submission, not a
figure: the consultant sees it on the dossier and accepts or rejects it, and
accepting is the only path that writes an emissions report. Rejection keeps the
submission and its reason. Accepting spends the link.

## House rules

- Numbers come from the engine in `src/lib/value-chain/report.ts`; nothing
  on a page or in an export is typed in as a total.
- A figure that cannot be computed is null with the reason. A total holding
  a null is null. Nothing is ever reported as zero for want of data.
- The allocation basis, tier, assurance and evidence travel with every figure
  into the export.
- Every engagement transition writes an audit row.

## Not yet built

Public-report harvesting and pre-filled requests, sending the links and chasers
by mail from the portal, and PACT or VSME machine exchange. The brief in the
product docs covers each; this module is the graph, lifecycle, evidence and
analysis layer they attach to.
