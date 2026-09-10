# NZC AI — Feature Brief: Value Chain Engagement & Document Intelligence

**Workstream:** NZC AI platform, Scope 3 Layer 2 · **Module id:** `vce`
**Owner:** James Cutter · **Build agent:** Claude Code, existing deterministic-engine conventions
**Status:** Draft v1, 10 September 2026 · for build/priority decision
**Relationship to other briefs:** expands §6 (Data collection) and the partner tables of `nzc-ai-scope-3-brief.md`, which stands as Layer 1 (boundary, ledger, factors, engines). Read Layer 1 first. Reuses the RFI portal and consent wizard from the Portfolio Intelligence brief and the evidence trail from the ECR brief.

**Trigger:** Welcome Break's ESG manager, on why they went to Watershed: *"you are weak on Scope 3."* James's read: NZC AI records ledgers and basic in/out. It needs to record, chase, analyse and answer Scope 3 data moving in both directions, not sit as a two-dimensional recording system.

---

## 1. The diagnosis

### 1.1 What a ledger cannot do

Layer 1 gives an activity ledger: a row per purchase, quantity or reading, a factor, a result. It answers *what do we have*. Every hard part of Scope 3 is a different question:

| The real question | Ledger answer |
|---|---|
| What don't we have, and what is it worth? | Silent |
| Who holds it? | Silent |
| Have we asked? When, whom, how, how many times? | Silent |
| What did they send back, and where is it? | An attachment somewhere in Outlook |
| Is what they sent any good, and does it contradict what they published? | Silent |
| Who is asking *us*, for what, by when? | Silent |
| What should we do next quarter, in what order? | Silent |

Those are workflow, relationship and evidence questions. A row-and-column store has nowhere to put them. The complaint "weak on Scope 3" almost never means the arithmetic is wrong; it means the system does nothing between the moment a gap is identified and the moment a number appears.

### 1.2 The dimensional shift

Layer 1 is two-dimensional: **activity × period**. This module adds two more:

- **Counterparty relationship** — a supplier, franchisor, distributor, tenant or customer is a long-lived entity with a state, a history, contacts, contracts, leverage, maturity and a data trajectory across years. Not a text field on a spend line.
- **Evidence provenance** — every figure traces to an extraction, from a document, that arrived in a message, from a person, on a date, under a confidentiality basis. Assurance walks that chain backwards.

Everything below exists to make those two dimensions first-class.

### 1.3 The insight the market misses: traffic runs both ways

Watershed, Sweep, Persefoni and every supplier-engagement product model the client as the **requester**: you have suppliers, you send them a survey. For Welcome Break that is at best half the picture, and arguably the smaller half.

Welcome Break is asked for data by Yum! Brands (per-restaurant reduction targets with franchisees), Starbucks, Wyndham, its parent Applegreen for the CSRD consolidation, its lenders, and its landlords. It asks for data from food distributors, packaging suppliers, waste contractors, logistics providers, its fuel supplier and its concession tenants. The same counterparty is often on both sides: Starbucks is a franchisor that demands outlet data *and* a supplier of coffee whose product footprints Welcome Break needs.

And the leverage runs the wrong way. Welcome Break cannot compel Yum! to disclose. Yum! can compel Welcome Break. A module that only models outbound requests cannot represent the majority of Welcome Break's actual Scope 3 workload.

**So the module has two symmetrical surfaces: a Request Outbox and a Request Inbox.** The Inbox is the differentiator. It also opens a second market: every SME supplier drowning in customer questionnaires needs exactly the Inbox and nothing else, which is a low-price, high-volume entry product that seeds the graph. See §12.

### 1.4 What has changed externally, and why now

| Development | Date | Consequence for this design |
|---|---|---|
| **PACT Technical Specifications v3.0.3** (data model plus HTTP REST API), on PACT Methodology v3.0 | Methodology Apr 2025, specs Nov 2025 | Product carbon footprints can be exchanged system-to-system with declared data quality and verification status. The ceiling on "primary data" is no longer questionnaire response rates. Build a PACT client and a PACT endpoint. |
| **SBTi Corporate Net-Zero Standard V2**, validation opens early 2027 | Published 2026 | Scope 3 target types now include supplier and customer **alignment** targets, not just absolute reduction. Coverage still 67% near-term where Scope 3 exceeds 40% of the total. Food-sector companies must ensure emissions-intensive suppliers (livestock, dairy, soy, palm, grains) hold validated net-zero targets by 2030. Engagement is now a *measured, target-bearing activity*, so the platform must track which counterparties hold validated targets and compute coverage from it. |
| **EFRAG VSME Digital Template and XBRL taxonomy**, free converter; refresh due Q4 2026 after the Commission's Voluntary Standard of 3 July 2026 | Oct 2025, updating | A license-free, structured format an SME supplier can fill once and send to everyone. Adopt it as the default ask, which also respects the Omnibus rule that a sub-1,000-employee supplier may decline anything beyond VSME. |
| Supplier fatigue documented: 79% of sustainability professionals name supplier data availability as their top Scope 3 obstacle; suppliers receive many near-identical questionnaires in different formats; SMEs lack the expertise to answer | Sphera 2025 survey, n=315; CDP 2025 guidance | Response rate is a design problem, not a sales problem. Every principle in §2 follows from it. |

---

## 2. Design principles

These are the arguable positions. Everything downstream is implementation.

**P1 — Ask last, not first.** No request goes out until the enrichment pipeline (§5) has harvested everything public about that counterparty and pre-filled the form. The ask becomes "we found these three figures in your 2025 report, confirm or correct them, and we need only these two more." Every competitor sends a blank questionnaire to everyone. Pre-filling is the single highest-leverage change available to response rates, and it costs nothing per supplier once the pipeline exists.

**P2 — The lowest-friction channel wins.** A supplier portal that requires an account is a response-rate tax. Rank channels by friction and support all of them: machine-to-machine (PACT, SFTP, distributor feed) → reply to an email with an attachment, which the reader agent handles with no login → one-click confirmation of pre-filled public data → tokenised single-page form, no account → portal login, last resort. Never make a supplier create a password to give you a number.

**P3 — Speak the standards, don't invent a questionnaire.** Ask in VSME for SMEs, PACT for product footprints, GHG Protocol category shape for larger corporates, and the franchisor's own template when replying to one. A bespoke NZC questionnaire is a new burden; a standard format is one the supplier may already have answered.

**P4 — Every figure carries a dossier.** A number in the inventory links to its extraction, document, message, counterparty and confidentiality basis, in one click, forever. This is the assurance product and the reason a client trusts a small vendor.

**P5 — Engagement is a relationship with a state, not a mail-merge.** Counterparties move through a lifecycle across years (§4). Last year's dossier is this year's starting point. The system should get cheaper to run every year, and should show that trajectory (§9.1).

**P6 — Rank effort, don't spread it.** Compute an engagement score per counterparty from materiality, uplift potential, winnability and leverage (§9.2), and work the ranked list. Chasing 400 suppliers equally is how programmes fail.

**P7 — Agents propose, engines compute, humans approve.** Agents find, read, classify, draft, rank and flag. `s3/*.py` and `vce/*.py` compute every number. A human approves anything that leaves the building and anything that changes a figure. Non-negotiable for a regulated practice.

**P8 — Consented reuse across clients.** A supplier answering for client A can, with explicit consent, release the same response to client B. Over time this builds a UK mid-market value-chain data commons that a US enterprise vendor cannot easily replicate here. Sustainability data only, never pricing or commercial terms, supplier-owned, revocable. See §12.2 for the governance.

---

## 3. The counterparty graph

Not a supplier list. A graph, because the same legal entity plays several roles and roles nest.

### 3.1 Entities

| Concept | Meaning |
|---|---|
| **Counterparty** | A legal entity. Company number where known, enriched from Companies House: registered name, SIC, employee band, turnover band, group parent, status. Employee band drives the VSME cap under Omnibus. |
| **Group** | Parent-child links. Engage Yum! Brands once and it covers KFC and Taco Bell; engage Compass once and it covers several trading names. Requests roll up to the level that can actually answer. |
| **Relationship** | One counterparty ↔ one client organisation, with a **role set**, not a single role: supplier, distributor, franchisor, franchisee, concession tenant, landlord, waste contractor, logistics provider, fuel supplier, charging partner, customer, lender, parent. Starbucks at Welcome Break holds `franchisor` + `supplier` + `brand_licensor` simultaneously. |
| **Direction** | Each role is upstream, downstream or both. Drives which categories the relationship can serve and whether requests flow out, in or both ways. |
| **Contact** | People, with seniority, function (day-to-day, account manager, sustainability lead, commercial director), preferred channel, language, and a responsiveness history. Personal data; §12.1. |
| **Contract** | Term, renewal or break date, notice period, and any data-sharing clause already in force. Renewal proximity is leverage; a green-lease or franchise clause is an entitlement. |
| **Obligation** | A recurring duty in either direction: "Yum! requests outlet energy each March", "we must give Applegreen category-level Scope 3 by 31 January". Generates work items automatically. |
| **Dossier** | Everything ever received from or sent to a counterparty: documents, messages, responses, consents, conflicts, decisions. The unit an auditor reads. |

### 3.2 Why the role set matters

The boundary rules in Layer 1 §3 are driven by outlet operator role. The engagement rules are driven by relationship role, and they differ. A concession tenant is out of the client's Scope 1/2 but is the *only* source of the meter data the client needs for category 13. A franchisor is a data source for menu-item footprints and a data demander for outlet energy. Modelling role as a single enum loses both cases.

---

## 4. Engagement lifecycle

One state machine per relationship per reporting period per data need. Not "sent / received".

```
UNIDENTIFIED → IDENTIFIED → ENRICHED → SCOPED → CONTACTED → ENGAGED → RESPONDING
                                                     ↓            ↓         ↓
                                                 UNREACHABLE   DECLINED   PARTIAL → COMPLETE → VERIFIED
                                                                                        ↓
                                                                                     SUPERSEDED / LAPSED
```

| State | Meaning | Exit condition |
|---|---|---|
| `UNIDENTIFIED` | Spend or activity exists, counterparty not resolved to a legal entity | Match to Companies House |
| `IDENTIFIED` | Entity known, nothing gathered | Enrichment run |
| `ENRICHED` | Public disclosures harvested, pre-fill prepared, tier assigned | Data need scoped |
| `SCOPED` | We know exactly what we need and what we already have | First contact approved |
| `CONTACTED` | Request sent, no human response | Reply, or escalation ladder exhausted |
| `ENGAGED` | A person has responded, even to say "not yet" | Data begins arriving |
| `RESPONDING` | Partial data in, thread live | All fields present |
| `PARTIAL` | Some fields answered, deadline near | Complete, or fall back to secondary with disclosure |
| `COMPLETE` | All requested fields received | Review queue passes |
| `VERIFIED` | Reviewed, conflicts resolved, tier assigned, figures live in the ledger | Period ends |
| `DECLINED` | Refused, with a reason code (VSME right to refuse, commercial confidentiality, no capability) | Re-approach next period or accept permanently |
| `UNREACHABLE` | Ladder exhausted, no contact found | Human task, or accept |
| `LAPSED` | Previously verified, evidence now expired or stale | Re-chase, automatically |

Every transition writes an audit row with actor, timestamp, trigger and evidence. `LAPSED` is what makes the system self-sustaining: certificates expire, reports are annual, and the engine re-opens the chase without anyone remembering.

---

## 5. Enrichment: the public-first pipeline

Runs on every counterparty before any request. Cheap, unlimited, and it is the reason P1 works.

| Source | What it yields | Access |
|---|---|---|
| Companies House | Legal name, number, SIC, group structure, accounts, employee and turnover band | Free API |
| Corporate sustainability / annual reports | Scope 1, 2, 3 by category, boundary, base year, targets, intensity, assurance statement | Site discovery, PDF extraction |
| CDP public responses | Emissions, targets, verification status, supplier engagement rating | Public disclosures |
| SBTi target dashboard | Target type, scope coverage, base and target year, validation date and status | Public dataset. Feeds SBTi V2 supplier-alignment coverage directly |
| EPD registries (ECO Platform, EPD International, BRE) | Product declarations with declared unit, A1–A3, PCR, validity, verifier | Registry search |
| PACT network | Machine-readable PCFs with data quality and verification fields | REST API, §6.1 |
| Manufacturer PCF datasheets and packaging specs | Item-level footprints, material composition | Site discovery, extraction |
| Environment Agency registers | Waste carrier and permit status for waste contractors | Public register |
| EPC register, ESOS/MESOS public data | Building performance for landlords and leased assets | Existing NZC connectors |
| Ecoinvent, DESNZ, Agribalyse, WRAP | Fallback secondary factors when nothing primary exists | Layer 1 factor library |

Output per counterparty: a **pre-fill pack** — every field the request would ask, populated where public evidence exists, each with a source link, a page reference and a confidence. The request then asks only for the gaps plus confirmation of the pre-fill. A supplier who publishes a report gets a two-minute confirmation, not a forty-field survey.

Secondary benefit: for counterparties who never respond, the pre-fill *is* the data, at a better tier than spend-based, with the public document as evidence. Enrichment improves the inventory even at a zero response rate.

---

## 6. Ingestion channels

Ranked by friction, per P2. All write to the same review queue.

### 6.1 Machine-to-machine

- **PACT client and endpoint.** Implement the v3.0.3 REST API both ways: pull PCFs from counterparties who host a PACT endpoint, and expose one so the client's own downstream customers can pull from us. Carries data quality and verification fields natively, so tier assignment is automatic rather than inferred. Being an early UK PACT-conformant node is a defensible position and a marketing asset.
- **VSME XBRL.** Accept the EFRAG Digital Template (Excel) and its XBRL-JSON/CSV output through the free converter. Zero extraction risk, and it is the format the Commission's Voluntary Standard points SMEs at.
- **Distributor and contractor feeds.** SFTP or API for brand-mandated distributors (item, kg, outlet, period), waste contractors (tonnes by EWC code and route), logistics (tkm), fuel suppliers (litres by type). One integration replaces hundreds of individual asks — for a motorway operator this single channel probably covers most of category 1 by volume.

### 6.2 Human channels

- **Reply-by-email.** A per-client monitored mailbox. The supplier replies to the request with a spreadsheet, a PDF or a sentence, and the reader agent classifies, extracts and files it against the open request. No login, no portal, no friction. This will be the highest-volume human channel and should be built first among them.
- **One-click confirmation.** Tokenised link showing the pre-filled public figures with "Confirm" / "Correct" per row. Under a minute to complete.
- **Tokenised form.** Single page, no account, save-and-resume, pre-filled, only the gaps. Reuses the consent wizard's token infrastructure.
- **Bulk template.** For large suppliers with many product lines or sites; validation report on upload.
- **Portal account.** Only for counterparties with a long, multi-period relationship who want one.

Everything, on every channel, lands as a Document (§7) plus a structured Response, both attached to the dossier.

---

## 7. Document intelligence

The part the ESG manager was really describing. A document store is a folder; document intelligence is a folder that knows what each file says, whether it is still valid, and which numbers depend on it.

### 7.1 Every artefact becomes a Document

Whether it arrived by email, was uploaded, or was harvested from a website. Common record: type, issuer counterparty, period covered, issue date, validity window, language, confidentiality basis, source channel, hash, storage key, extraction status, verification status, and links to every figure it supports.

### 7.2 Types and extraction schemas

Each type has a schema; extraction is proposed by the reader agent with per-field confidence and confirmed by a human before it moves a number.

| Document type | Extracted fields | Validity / re-chase rule |
|---|---|---|
| Sustainability or annual report | Scope 1, 2 location and market, Scope 3 by category, boundary, base year, targets, intensity, assurance level and provider | Annual; re-chase when the next report is published |
| CDP response | Emissions by scope, targets, verification, supplier engagement rating | Annual cycle |
| SBTi target letter or dashboard entry | Target type, scope coverage %, base and target year, status, validation date | On status change; feeds SBTi V2 alignment coverage |
| EPD / PCF datasheet | Declared unit, A1–A3 and full modules, PCR, system boundary, verifier, validity to | Expiry date drives automatic re-chase |
| PACT payload | Structured, no extraction | Refresh on version change |
| VSME return | Structured, no extraction | Annual |
| ISO 14001 / 50001 / 45001 certificate | Certified scope, sites covered, certification body, expiry | Expiry drives re-chase |
| Assurance statement | Level (limited or reasonable), scope, provider, date, exclusions | Annual |
| Invoice / delivery note / manifest | Product code, quantity, unit, date, supplier | Per transaction |
| Waste transfer note or duty-of-care return | Tonnes by EWC code, treatment route, carrier, site | Quarterly or annual |
| Utility bill | kWh, period, MPAN/MPRN, supplier, tariff | Monthly |
| Franchise, concession or lease agreement | Data-sharing clause, term, break, obligations both ways | On renewal; seeds Obligations |
| Franchisor data request | Fields requested, deadline, template, submission route | Creates an Inbox work item |

### 7.3 Conflict detection

Runs automatically whenever a document or response lands. Each conflict is a queue item with the two values, their sources, and an agent-proposed resolution and reason. The human decides; the decision is recorded and reused.

Detected classes:
- Reported figure differs from the same figure in the counterparty's public report
- Allocation basis changed between periods without explanation
- Sum of emissions allocated to all customers exceeds the counterparty's own reported total
- A PCF's declared unit does not reconcile with our purchase unit
- A renewable claim with no certificate evidence attached
- Certificate scope excludes the sites we buy from
- Prior-year figure restated without a restatement note
- Two documents from the same counterparty disagree

### 7.4 Confidentiality

Suppliers share commercially sensitive material. Each Document carries a basis: public, shared-under-NDA, shared-for-this-client-only, or consented-for-reuse. Access control follows the basis, exports respect it, and a figure can be used in an inventory while its underlying document remains visible only to named roles. NDA records live on the relationship with expiry tracking.

---

## 8. The chase engine

### 8.1 Tiering

Every relationship gets an engagement tier each period, from the score in §9.2:

| Tier | Approach | Typical population |
|---|---|---|
| **T1 Primary** | Named owner, direct contact, PACT or bespoke primary data, possibly a joint reduction plan | Top counterparties by uplift × leverage |
| **T2 Targeted** | Pre-filled ask for a small number of fields, standard cadence | Material but lower leverage |
| **T3 Public-only** | No ask. Enrichment output used as evidence | Publishers with no incremental need |
| **T4 Secondary** | Spend or average-data factors, documented as such | Long tail |

Tiers are recomputed each period; a T4 counterparty that becomes material moves up automatically and appears on the plan.

### 8.2 Cadence, back-planned from the deadline

Waves are planned backwards from the binding date (CSRD consolidation, SBTi submission, franchisor return), not forwards from today:

| Point | Action |
|---|---|
| T−16 weeks | First contact, pre-filled, day-to-day contact, VSME or PACT as appropriate |
| T−12 | Reminder, same contact, restating only what is outstanding |
| T−9 | Escalate to the second contact on the ladder (account manager or sustainability lead) |
| T−6 | Commercial escalation: the client's own procurement or brand lead is brought into the thread |
| T−4 | Final notice with the consequence stated plainly: we will use a secondary estimate and disclose the data quality |
| T−2 | Fall back to secondary, mark `DECLINED` or `UNREACHABLE`, tell them what was assumed on their behalf |

Nothing about this is novel in isolation. What is missing from every product in the market is that it runs itself, per counterparty, with the state and the outstanding-field list carried between steps.

### 8.3 Fatigue control

- **One open ask per counterparty per client.** Multiple data needs are batched into a single message.
- **Cross-client throttle.** A supplier serving three NZC clients receives one combined request, not three. This is only possible because NZC is consultant-led and multi-tenant, and it is a direct response to the documented fatigue problem.
- **Escalate the person, not the frequency.** Move up the contact ladder rather than sending more mail to a contact who is not responding.
- **Honour the refusal.** Under Omnibus a sub-1,000-employee supplier may decline anything beyond VSME. The engine records `DECLINED` with that reason code, stops asking that period, and never lets a request template exceed VSME for a counterparty in that band.

### 8.4 Learning

Record outcomes against features of each attempt: channel, contact seniority, pre-fill present or not, message length, day and time, format asked for. Report observed response rates by feature and let the engine order future attempts by what has worked for that counterparty, that sector and that client. Report the evidence; do not overclaim a model. Even simple observed-rate ordering beats a fixed template, and the data accrues.

---

## 9. Analysis: what the module concludes, not just records

### 9.1 Data quality trajectory

Per category and per counterparty: tier now, tier last period, tier achievable, and what stands between them. Rolled up to a coverage curve with a forecast — the primary-data share this programme reaches next period if the plan is executed, and the share if nothing is done. This is the ESRS E1-6 primary/secondary split as a managed trajectory rather than an annual accident, and it is the SBTi data improvement plan, generated.

It is also the commercial story: year one is a large chase, year two is deltas and expiries. The system gets cheaper to run each year, and the curve proves it.

### 9.2 The engagement score

For each relationship, computed not guessed:

| Component | Definition |
|---|---|
| **Materiality** | Their share of the client's Scope 3, from the Layer 1 ledger |
| **Uplift** | tCO₂e that would move from secondary to primary if they responded: emissions × (current tier → achievable tier) |
| **Winnability** | Observed and inferred likelihood of response: public report exists, CDP responder, SBTi target holder, named contact, prior response to us or another NZC client, employee band |
| **Leverage** | Our spend as a share of their turnover (Companies House band), contract renewal proximity, contractual data-sharing entitlement, and **direction of dependence** — negative where they hold power over us, as a franchisor does |
| **Score** | Uplift × Winnability × Leverage, ranked |

Output is the **engagement plan**: a ranked worklist with the tonnes at stake and the reason for each entry. Where leverage is negative the plan says so and proposes the realistic route — accept the franchisor's published brand-level footprint, or negotiate at contract renewal — rather than queuing a request that will not be answered.

### 9.3 Reconciliation

Where a counterparty-reported figure and our own estimate both exist, hold both, show the variance, record which was used and why, and track how the variance behaves over time. A large persistent gap is a finding worth raising with the supplier, and a question an auditor will ask.

### 9.4 Peer comparison

Counterparties in the same sector compared on intensity per £ of spend, flagging outliers in both directions. A supplier far below its peers may have a genuine advantage worth designing procurement around; far above, an engagement priority. Uses only data the client is entitled to see, never other clients' figures.

### 9.5 Target and alignment coverage

Ingest counterparty targets from the SBTi dashboard and from documents. Compute:
- Share of Scope 3 emissions attributable to counterparties holding validated science-based targets
- SBTi V2 supplier and customer **alignment** target coverage, and progress toward it
- For food-heavy clients, the V2 2030 requirement that emissions-intensive suppliers (livestock, dairy, soy, palm, grains) hold validated net-zero targets — a named list, with status, of who does and does not

For Welcome Break this last line is not theoretical. It is a list of meat, dairy and coffee suppliers with a 2030 deadline attached, and no product on the market generates it from UK mid-market procurement data.

### 9.6 Levers

Model the effect of switching a distributor, a packaging material, a menu mix or a supplier with a validated target, on both the inventory and the target coverage. Costs where known, from the existing financial appraisal engine.

---

## 10. The agent fleet

Named agents with narrow jobs. Each has an explicit tool list, and the guardrails in P7 apply without exception.

| Agent | Job | Writes | Human gate |
|---|---|---|---|
| **Resolver** | Match unidentified spend and activity counterparties to legal entities; detect group structure | Proposed matches with confidence | Confirm above a threshold, auto-accept exact matches |
| **Enricher** | Find and read public disclosures; build the pre-fill pack | Documents, proposed extractions | Confirm before pre-fill is used in an outbound message |
| **Scoper** | Determine, per counterparty, exactly what is still needed after enrichment | Data-need list | None; it only reads |
| **Chaser** | Decide who to contact, when, through which channel and contact; draft the message in full context of what is outstanding and what was already sent | Draft messages | Approve to send, or auto-send inside an explicit policy: named templates, named recipients, rate cap, no attachments |
| **Reader** | Classify inbound documents, extract to the type schema, attach to the open request | Documents, proposed figures with confidence | Confirm before any figure enters the ledger |
| **Reconciler** | Detect conflicts, propose a resolution with reasoning | Conflict items | Human decides, decision recorded |
| **Analyst** | Answer questions over engine output with citations: why did a category move, who should we engage next, what is at stake | Nothing | Read-only |
| **Watcher** | Monitor counterparties for new reports, target validations, certificate expiries, M&A, insolvency; refresh the graph and re-open lapsed chases | Flags, lapsed-state transitions | Review queue |

Model routing follows the existing convention: local Ollama for narrative, drafting and classification over client data; the Anthropic API only for the regulatory and public-source watch, which touches no client data. No agent computes, rounds or fills a figure.

---

## 11. Downstream and inbound

### 11.1 Request Inbox

Inbound obligations are first-class work items: source counterparty, template, fields requested, deadline, owner, status, and the response pack produced.

- **Auto-answer from the ledger.** Most fields a franchisor asks for already exist: outlet energy, waste tonnage, packaging volumes, refrigerant, intensity per restaurant. The Inbox maps the requester's template to the ledger and drafts the response, with a human sign-off.
- **Template memory.** Yum!'s March template, once mapped, is remembered. Next year's request is answered in minutes.
- **Consistency guard.** The same figure sent to the franchisor, the parent's CSRD consolidation and the lender must agree, and the system enforces that rather than hoping. Divergent submissions are a real audit finding.
- **Obligation calendar.** Recurring inbound duties generate work items automatically, into the existing compliance calendar.

### 11.2 Downstream counterparties

- **Franchisees** (where the client is the franchisor): outbound packs and returns, category 14.
- **Concession tenants and charging partners**: meter data via the existing consent wizard, feeding category 13. Green-lease clauses generated from the green-lease skill where consent is refused and the lease is up for renewal.
- **Customers**: category 11 needs no engagement, it is sales data — but customers increasingly send the client CSRD value-chain requests, which land in the Inbox.

---

## 12. Commercial consequences

### 12.1 A second product

The Inbox alone, sold standalone to SME suppliers who are being asked for data by their customers, is a low-price high-volume product. It needs no ledger, no boundary rules and no factors beyond VSME. Every supplier onboarded that way joins the graph, arrives pre-enriched, and can consent to release to the NZC clients who buy from them. The entry product feeds the enterprise product.

### 12.2 The consented data commons

With supplier consent, a response given to one client is available to others. Governance is the whole point:
- Sustainability data only. Never price, volume, terms or anything commercially sensitive between competing buyers.
- The supplier owns the record, sees who has access, and can revoke.
- Consent is explicit, per-recipient or blanket at the supplier's choice, and logged.
- Competition-law review before launch, because a shared supplier database touching buyers who compete needs it.
- Data protection: supplier contacts are personal data; ROPA entry, retention, and the existing PII retention job.

Handled properly this compounds. Watershed cannot replicate it for UK mid-market suppliers because it is not in those supply chains.

---

## 13. Data model additions (schema `vce`)

| Table | Key fields |
|---|---|
| `vce_counterparty` | legal_name, company_number, sic, employee_band, turnover_band, parent_id, status, enrichment_run_at |
| `vce_relationship` | counterparty_id, org_id, roles[], directions[], tier, engagement_score, first_period, active |
| `vce_contact` | relationship_id, name, email, phone, seniority, function, preferred_channel, language, responsiveness_score, consent_basis |
| `vce_contract` | relationship_id, type, start, end, break_date, notice, data_clause_ref, obligations[] |
| `vce_obligation` | relationship_id, direction, description, cadence, next_due, template_id, owner |
| `vce_data_need` | relationship_id, period, category, fields[], satisfied_by[], outstanding[], achievable_tier |
| `vce_engagement` | relationship_id, period, state, entered_at, actor, trigger, deadline, wave_id |
| `vce_message` | engagement_id, direction, channel, contact_id, template_id, subject, body, sent_at, approved_by, thread_ref |
| `vce_document` | counterparty_id, type, period, issue_date, valid_from, valid_to, language, confidentiality, channel, hash, storage_key, extraction_status, verification_status |
| `vce_extraction` | document_id, schema_version, field, value, unit, page_ref, confidence, confirmed_by, confirmed_at |
| `vce_response` | engagement_id, format (vsme, pact, template, freeform), payload, received_at, tier_achieved |
| `vce_conflict` | subject_ref, value_a, source_a, value_b, source_b, class, proposed_resolution, decision, decided_by, rationale |
| `vce_consent` | counterparty_id, scope, recipient_org_id, granted_at, revoked_at, evidence_id |
| `vce_target` | counterparty_id, source, type, scope_coverage, base_year, target_year, status, validated_at |
| `vce_pact_endpoint` | counterparty_id, base_url, auth_ref, last_sync, conformance_version |
| `vce_attempt_outcome` | engagement_id, channel, seniority, prefilled, length_band, sent_dow, sent_hour, responded, hours_to_response |

Row-level security follows the existing consultant and business roles. Counterparty-facing rows are reachable only through tokenised pages. `vce_consent` gates all cross-client visibility.

---

## 14. Engines (`vce/*.py`, deterministic, golden-tested)

| Engine | Function |
|---|---|
| `resolve.py` | Counterparty matching and group rollup; deterministic rules, agent proposals confirmed |
| `scope.py` | Data-need computation: required fields per category and role, minus what enrichment and prior periods already satisfy |
| `tier.py` | Engagement tier assignment from the score |
| `score.py` | Materiality, uplift, winnability, leverage and composite score |
| `plan.py` | Wave and cadence planning back-calculated from deadlines; contact ladder sequencing |
| `quality.py` | Tier per figure, primary/secondary share per category, trajectory and forecast (extends Layer 1 `s3/quality.py`) |
| `reconcile.py` | Conflict classes, variance tracking, resolution application |
| `coverage.py` | SBTi V2 alignment coverage, validated-target share, food-sector 2030 list, CSRD E1-6 split |
| `validity.py` | Document expiry, staleness and lapse detection driving re-chase |
| `outcome.py` | Observed response rates by attempt feature; ordering recommendations |

---

## 15. Surfaces

`src/features/value-chain/*` at `/value-chain/*`, same shell, counters and column chooser as Portfolio Intelligence.

- **Counterparties** — the graph, with tier, state, score, outstanding items, next action. Filter by role, direction, category, state.
- **Counterparty dossier** — the single most important screen. One counterparty: timeline of every message, document, response, conflict and decision; contacts and ladder; contracts and obligations; targets; figures they support; consent status.
- **Engagement plan** — the ranked worklist with tonnes at stake and reason per entry. This is what a sustainability lead opens on a Monday.
- **Requests out** — waves, cadence, live states, drafts awaiting approval.
- **Requests in** — inbound obligations, deadlines, draft response packs, consistency warnings.
- **Documents** — library with type, validity and expiry board; what is stale, what lapses next quarter.
- **Review queue** — inbound extractions with confidence, the conflicts they raise, the tier they would achieve and the delta they would make to the inventory. Accept, edit, reject.
- **Coverage and quality** — trajectory and forecast, ESRS split, SBTi coverage.

Chat and MCP tools: `vce_next_actions`, `vce_counterparty_status`, `vce_explain_figure`, `vce_coverage_forecast`, `vce_conflicts_open`, `vce_inbound_due`.

---

## 16. Phasing

Runs alongside Layer 1's S2–S6. Each phase ships green CI and a demo note.

| Phase | Weeks | Deliverable |
|---|---|---|
| **E1 Graph** | 1–2 | Counterparty, relationship with role sets, contacts, contracts; Companies House enrichment and resolution; Counterparties screen and dossier shell |
| **E2 Documents** | 3–4 | Document store, type schemas, reader agent extraction with confidence, review queue, validity and expiry, conflict detection v1, confidentiality bases |
| **E3 Enrichment** | 5–6 | Public-first pipeline, pre-fill packs, target ingestion from SBTi and CDP, Watcher agent |
| **E4 Outbox** | 7–8 | Data-need scoping, tiering and scoring, wave planning, chaser agent with approval gate, email-in ingestion, tokenised confirm and form, VSME template, fatigue and refusal rules |
| **E5 Inbox** | 9 | Inbound obligations, template mapping, auto-drafted response packs, consistency guard, obligation calendar |
| **E6 Exchange and analysis** | 10–11 | PACT client and endpoint, distributor and contractor feeds, quality trajectory and forecast, reconciliation, peer comparison, SBTi coverage, engagement plan, levers |

Consented cross-client reuse (§12.2) ships only after the competition-law and data-protection review, not on this timeline.

---

## 17. Acceptance

1. **Two-way traffic.** Starbucks is created once, holds `franchisor` + `supplier`, appears in both the Outbox (PCF request) and the Inbox (outlet data obligation), and the dossier shows both threads.
2. **Ask last.** For a counterparty publishing a sustainability report, enrichment produces a pre-fill pack with a page reference per figure, and the generated request asks only for the unsatisfied fields.
3. **Zero-response value.** With no counterparty responding at all, the enrichment pipeline still raises the inventory's primary-data share, and every raised figure cites a public document.
4. **Email-in.** A reply with a spreadsheet attached, sent to the client mailbox, is classified, extracted, attached to the open request, and lands in the review queue with confidence scores. No login occurs anywhere in that path.
5. **Conflict.** A counterparty reports a Scope 1 figure that differs from its public report; the conflict is raised, the proposed resolution carries a reason, the human decision is recorded, and the unused value is retained.
6. **Refusal.** A counterparty in the sub-1,000-employee band is never sent a template exceeding VSME; a refusal on that basis sets `DECLINED` with the reason code and suppresses further asks that period.
7. **Lapse.** An ISO certificate passing its expiry moves the engagement to `LAPSED` and re-opens the chase without human action.
8. **Ladder.** With no response at T−12 and T−9, the plan escalates to the next contact and then to commercial escalation, and each step's draft states only what remains outstanding.
9. **Ranked plan.** The engagement plan orders counterparties by uplift × winnability × leverage; a franchisor with negative dependence appears with the realistic route, not a queued request.
10. **Inbox.** A franchisor template mapped once produces a complete draft response pack from the ledger the following period, and the consistency guard blocks a figure that disagrees with what was sent to the parent.
11. **PACT.** A PCF pulled from a conformant endpoint enters at tier A with its native data quality and verification fields, with no manual extraction.
12. **Provenance.** Every figure in the inventory opens to extraction, document, message, counterparty and confidentiality basis in one click.
13. **No agent computes.** Grep test over `vce/` and `s3/`: no model call on the path to any number. Every agent-proposed extraction carries `confirmed_by` before it affects a figure.
14. **Nothing sends unapproved.** No outbound message leaves without either explicit approval or a stored auto-send policy naming template, recipients and rate cap.

---

## 18. Hard constraints

1. Numbers come only from `vce/*.py` and `s3/*.py` engines and SQL views.
2. Client and counterparty data stays local. Outbound calls: counterparty mail via M365 Graph, PACT endpoints, public registries and Companies House, distributor feeds. The Anthropic API sees no client data.
3. Every state transition, message, extraction, decision and consent writes an audit row.
4. Confidentiality basis is enforced on read and on export, not just recorded.
5. Supplier contacts are personal data: ROPA entry, retention job, lawful basis documented.
6. No cross-client data movement without a logged `vce_consent` row.
7. Reports built on this data keep the qualified sign-off banner.
8. Feature flags `vce`, `vce_agents`, `vce_autosend`, `vce_pact`, `vce_commons` default off in production until E6 passes.

---

## 19. Open questions for James

1. **Design partner.** Approach Welcome Break's ESG team with the Inbox — answering Yum!, Starbucks and Wyndham from one dataset is work Watershed does not do and does not conflict with their purchase — or start with a supplier-side pilot?
2. **PACT conformance.** Register as a PACT-conformant solution, which carries a review cost but is a credible market claim, or implement the spec quietly first?
3. **Auto-send policy.** Is any outbound counterparty message auto-sent within a policy, or does every message get human approval in year one? Approval-only is safer and slower.
4. **The commons.** Competition-law review before or after E6? It gates the largest strategic prize.
5. **Mailbox model.** One shared NZC mailbox per client, or delegated access to the client's own? Delegated is better for response rates and worse for isolation.
