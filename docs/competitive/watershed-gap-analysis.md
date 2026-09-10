# Watershed vs NZC Portal / NZC AI — competitive evaluation and gap analysis

**Prepared for:** James Cutter, NZC Portal Ltd / NZC AI
**Date:** 9 September 2026
**Status:** Draft v1 for internal review (James, Iain, Matthew)
**Trigger:** Welcome Break (Applegreen group) selected Watershed (watershed.com) over NZC Portal for Scope 3 measurement across its franchise and concession partners
**Companion briefs:** `docs/product/nzc-ai-scope-3-brief.md` (Layer 1 — boundary, ledger, factors, engines) and `docs/product/nzc-ai-scope-3-engagement-brief.md` (Layer 2 — counterparty graph, engagement, document intelligence, inbound requests, agents)

---

## 1. Executive summary

Watershed is a US enterprise carbon-accounting platform valued at $1.8bn, with roughly 400 staff, 800+ customers, a London co-headquarters, Verdantix and Forrester leader badges, and an aggressive "sustainability AI" story built on data-cleaning agents, AI report drafting and utility-bill OCR. Its median contract is around $70k a year plus implementation. It has no real-estate, energy-audit, EPC/MEES, ESOS, CRREM, NZCBS or GRESB functionality.

NZC Portal today is an ESOS, SECR and EPC/MEES compliance tracker with a half-built landlord portal, an unbuilt occupier portal, a microgeneration prototype and a set of strong but unshipped briefs (the ECR ledger, Portfolio Intelligence, the NZC AI sidecar, the EPC register and mapping modules). The advisory knowledge base behind it (30 skills) is genuinely differentiated. The software is not yet.

Welcome Break did not choose Watershed for ESOS or MEES. It is the franchisee-operator of KFC, Starbucks, Burger King, Waitrose, WHSmith and a dozen other brands across some 60 locations, its parent Applegreen is a CSRD Wave 2 company with a net-zero 2050 goal across all three scopes, it sells fuel (so SBTi forces a separate category 11 target), and its franchisors set per-restaurant targets. That is a Scope 3 buyer. NZC Portal has no Scope 3 product beyond the categories the GHG skill covers, and no concept of a franchisee, a franchisor, a concession tenant or a fuel retailer. Beyond that, Watershed won because:

1. It is a finished, assured, enterprise-grade system of record with SOC 2, data lineage, approval workflows and a "100% of audited footprints have passed" claim, versus a portal whose own August gap review found the ESOS deadline engine wrong and no Notification of Compliance module.
2. It covers the whole corporate footprint in one place: all 15 Scope 3 categories, 60+ integrations into finance and HR systems, supplier engagement, CSRD/ISSB/CDP builders. NZC Portal is building-centric.
3. It sells certainty: analyst badges, named UK references (Wise, Monzo, Royal Mail, Smiths Group), an assurance guarantee with a $250k fee waiver, in-house advisory, weekly customer success cadence.
4. Its AI story is visible and productised (agents, drafting, OCR). NZC AI's is on paper.

The strategic conclusion is not to chase Watershed on carbon-accounting breadth. It is to (a) close the credibility gaps that make any buyer nervous about a small vendor, (b) ship the real-asset depth Watershed cannot offer, and (c) coexist with Watershed at group level by exporting clean building data into it. Section 7 sets out a prioritised build plan; Section 8 sets out sales and positioning lessons; Section 9 sets out a win-back play for the lost client.

**Top ten gaps, in priority order**

| # | Gap | Why it loses deals | Fix |
|---|---|---|---|
| 1 | Product is not client-ready (occupier portal unbuilt, landlord logic incomplete, ESOS statutory calendar wrong) | Buyers demo both; an MVP with visible errors loses to a finished product every time | Finish MVP; fix the ESOS P1 list from the 19 Aug review before any further demos |
| 2 | No data-quality engine (gaps, overlaps, completeness, outliers, expected usage) | Watershed markets "150+ automated checks"; buyers now expect it | Ship ECR WS3 (already specified) |
| 3 | No data lineage / approval workflow / change log in the UI | Assurance readiness is Watershed's headline; auditors ask for it | Evidence trail exists in the design; expose it as a first-class "Audit" screen and export |
| 4 | No security attestation (SOC 2, ISO 27001, Cyber Essentials Plus) or public trust page | Procurement gate for any fund or listed company | Cyber Essentials Plus now; ISO 27001 within 12 months; trust page this quarter |
| 5 | No in-product AI (chat, flagging, OCR) | Watershed's entire 2026 narrative; NZC AI has the better knowledge base but nothing live | Build the sidecar Phase 0–2 (specified July 2026); ship PDF bill OCR into the portal |
| 6 | No Scope 3 product: no spend-based engine, no categories 2, 4, 8–15, no operator-role boundaries, no partner data collection, no data-quality tiers | This is the gap that lost Welcome Break; Watershed covers all 15 categories with supplier engagement and a CSRD builder | Build the Scope 3 module in the companion brief: Open CEDA (free, CC BY-SA, released by Watershed itself) plus DESNZ, ledger import, outlet roles, partner requests, ESRS E1-6 and SBTi outputs |
| 7 | No finance/HR/utility integrations beyond CSV | "60+ integrations" versus manual upload | EPC register, accounting packages, M365 mail for consent (Perse withdrawn Sep 2026, see `docs/spine/DECISIONS.md` D-4) |
| 8 | No report builder for SECR, GHG statement, TCFD/UK SRS inside the portal | Reports are a consultancy workflow, not a product feature | Generate branded packs from the ledger via existing skills (ECR §17 item 8) |
| 9 | No references, case studies, analyst coverage or public pricing | Small-vendor risk with nothing to offset it | Three named case studies, a pricing page with tiers, Verdantix briefing |
| 10 | No supplier engagement / targets / clean-power tracking | Table stakes on Watershed's "Act" pillar | REGO/PPA instrument tracking (already in ECR spec); SBTi target module; supplier survey lite later |

---

## 2. Watershed — product profile (September 2026)

Sources: watershed.com and en-GB pages (fetched via cached crawl because the domain is blocked from this environment), Watershed product-update blogs Dec 2024 to Jul 2026, Verdantix 2026 Green Quadrant press release, Forrester Wave Q2 2024, Vendr/Dcycle/rfp.wiki pricing aggregates. Full list in Section 10. Items marked [3P] are third-party and directional only.

### 2.1 Positioning

"The sustainability AI platform", organised as **Measure → Report → Act**. Founded 2019 by ex-Stripe staff; San Francisco with a London co-HQ. Customers skew to fintech, tech, logistics and listed multinationals. UK names: Wise, Monzo, Revolut, Royal Mail, Smiths Group, Skyscanner, Dr. Martens, Aon, IAG, Kainos. No UK property company, REIT or real-estate fund is named anywhere on the site.

### 2.2 Feature inventory

| Area | Watershed capability | Confidence |
|---|---|---|
| Scopes 1, 2, 3 | All scopes; purpose-built methodologies for all 15 Scope 3 categories; Kyoto-gas split; biogenic separate; dual location/market Scope 2 with in-product EAC allocation | Confirmed |
| Emission factors | CEDA (acquired VitalMetrics 2023) for spend-based; ecoinvent, DESNZ 2025, EPA/eGRID, Agri-footprint, WFLDB, HowGood for activity-based; "500,000+ factors" (Verdantix) / "2.3 million" (homepage, likely counts PCF nodes). Open CEDA released free under CC BY-SA May 2025 | Confirmed |
| Data ingestion | 60+ integrations (NetSuite, Workday, ADP, Rippling, Navan, BambooHR shown; SAP, Coupa, Concur, AWS, Snowflake claimed [3P]); CSV; customer-only API; AI utility-bill OCR; AI cleaning agents (units, currency, dates, dedupe, gap-fill) | Confirmed |
| Data quality and audit | 150+ automated checks across 70+ error types; full lineage with factor metadata; uploader/approver separation; data lock; change logs; auditor access; methodologies third-party assured annually | Confirmed |
| Frameworks | CSRD/ESRS product; CDP gold-accredited with API sync and predictive scoring; TCFD; ISSB/UK SRS; SECR (spreadsheet export); SFDR; California SB 253/261; ASRS; flexible "any ESG metric" builder (Mar 2026). **GRESB: none found** | Confirmed |
| UK compliance | SECR = "upload bills, download a spreadsheet". ESOS named only in marketing copy. No MESOS, EPC, MEES, NZCBS, CRREM, TM44, DEC content | Confirmed absence |
| Targets and reductions | SBTi/FLAG target setting; scenario modelling of energy cost, procurement, product and supplier swaps; AI hotspot identification; ROI calculator. No published MACC tool | Confirmed |
| Supply chain | Supplier portal with surveys, commitments, plans; ESG database of 20M+ firms; S&P Kensho auto-mapping; EcoVadis partnership (Mar 2026); Product Footprints (19-agent PCF builder, Sep 2025) | Confirmed |
| Clean power and removals | EAC tracking and allocation; cohort VPPAs (US grids, 130 MW 2026 cohort); marketplace of 30+ vetted removal projects; Frontier access; SAF certificates | Confirmed |
| Assurance | No audit product. "Verification Support" services plus Guaranteed Assurance Program: fee waiver up to $250k if assurance fails within 9 months (SB 253, CSRD per blog) | Confirmed |
| AI | Agents for ingestion, cleaning, analysis (natural-language Q&A with drill-down), report drafting, PCF editing, utilities spend-vs-emissions; "expert-built skills" library (Jun 2026); multi-agent hallucination checks; Anthropic, OpenAI and Gemini models | Confirmed |
| Buildings | "Manage facilities" with per-building and per-utility permissions; buildings-and-employees methodology; bill OCR; Arcadia (Urjanet) data partner. No asset-level portfolio, intensity benchmarking, CRREM, landlord/tenant split or GRESB export | Confirmed partial |
| Finance | Watershed Finance: PCAF-aligned Scope 3.15 incl. mortgages (PCAF score 4/5); 5 of top 6 US banks | Confirmed |
| Benchmarks | 10,000–30,000 peer disclosures inside report builders | Confirmed |

### 2.3 Platform

- Security: SOC 2 Type II, SOC 1, annual pen tests, SSO (SAML/OIDC), SCIM, audit-log API, public trust centre. ISO 27001 not publicly confirmed.
- EU data residency GA since August 2025.
- Multi-entity footprints with separate versions and approvals; role inheritance; per-building permissions; automatic currency and unit normalisation.

### 2.4 Commercial

| Item | Position |
|---|---|
| Pricing model | Custom annual subscription, no public tiers. Drivers: entities, integrations, Scope 3/supplier modules, advisory |
| Price points [3P] | Vendr median $70k/yr (range $21k–$158k); Dcycle "$50k–150k typical"; Greenly claims "from £79k"; implementation $10k–50k+ |
| Implementation | 2–4 months typical; 3–6 months to first reportable footprint at complex enterprises |
| Services | In-house Sustainability Advisory, Data Advisory, 21 scientists, policy team, weekly CSM cadence, customer Learning Hub, AI Fellowship; partners Deloitte, KPMG, Accenture, ERM, BSR |

### 2.5 Market position

- Funding: $100M Series C at $1.8bn (Feb 2024); $14.5M Form D Dec 2025 (extension). Headcount ~370–400; reported ~10% layoff May 2025 [3P, single source].
- Customers: "more than 800 companies", 90+ Fortune 500, 3–3.5 Gt CO₂e under management.
- Analysts: Verdantix Green Quadrant Leader 2026 (top of 21 vendors on capability and momentum); Forrester Wave Leader Q2 2024; IDC MarketScape Leader 2026; TIME100 Companies 2026.
- G2 4.5/5 (24 reviews) [3P]. Praise: UX, support, lineage, reporting speed. Complaints: price, rollout integration effort, documentation lagging release cadence, opinionated methodology.

### 2.6 Weaknesses relevant to NZC

1. Priced out of mid-market: floor ~£30–80k plus implementation; no trial, no self-serve, no consultant or white-label tier.
2. Assumes an in-house sustainability team and a services-heavy rollout.
3. No building-level energy engineering: no audit, interval data, degree-day normalisation, measure-level NPV/payback, ESOS action plan, ISO 50001, TM44.
4. UK compliance is thin: SECR is a configured export; nothing for ESOS/MESOS, MEES, EPC B 2031, NZCBS, CRREM.
5. No real-estate depth: no GRESB, no EPRA sBPR, no landlord/tenant boundary, no asset intensity benchmarking, no stranding analysis.
6. US-first release cadence (SB 253, US VPPAs, eGRID).
7. Lock-in and velocity risk flagged by reviewers.

Watch items: the June 2026 utilities spend-vs-emissions agent is Watershed's first move toward energy-cost analytics, and Deloitte/KPMG bundles could reach FTSE-scale property owners.

---

## 3. NZC Portal / NZC AI — current state

Sources: nzcportal.co.uk (public pages), Hidden Brains proposal (25 Aug 2026), NZC Portal ESOS/MESOS gap analysis (19 Aug 2026), Development Brief for EPC/MEES/Mapping/Solar (14 Aug 2026), NZC AI System Design (10 Jul 2026), ECR Feature Brief (29 Aug 2026), Portfolio Intelligence brief, Architecture & Strategy.

### 3.1 Live platform (app.nzcportal.co.uk)

| Area | State |
|---|---|
| Stack | Ruby on Rails backend; React/Next.js/TypeScript frontend; GitHub/Vercel; 80+ routes; one retained developer |
| Core | Users, roles, permissions, Stripe subscriptions built |
| ESOS module | Built: three-route data hub, 95% SEU selection, opportunities register, action plan and PU1/PU2, Review Centre workflow, MESOS-format PU export. Missing or wrong: Notification of Compliance preparer, statutory deadline engine (PU dates derived incorrectly), Reg 34A action-plan content, 12-month reference-period validation, conversion factor sets not configured, no qualification/group/SIC model, no ISO 50001 route, no assessment-level director sign-off, evidence pack ZIP "coming soon". Score: 34 requirements, 6 met, 15 partial, 11 missing, 2 incorrect |
| SECR, EPC/MEES, Energy Policy | Built, need testing and hardening. EPC register lookup and MEES risk engine briefed 14 Aug but not present in deployed build |
| Landlord portal | UI framework exists; portfolio, valuations, carbon reporting, TCFD, microgeneration, NZCBS logic and data flows incomplete |
| Client / occupier portal | Full build required |
| Microgeneration | Prototype; Google Solar integration broken; billing engine verified separately as a skill |
| Mapping | Not present |
| AI | None in product |
| Security | No published attestation or trust page |
| Marketing claims on site | Scope 1–3, SECR, ESOS, CRREM, SBTi, NZCBS, TCFD, data lineage, versioning, evidence storage, exportable report packs. Several of these are ahead of the deployed build |

### 3.2 Specified but not shipped

| Programme | Content | Effort per brief |
|---|---|---|
| ECR ledger (Measurabl parity) | Fund/site/space hierarchy, meter ledger, data integrity and completeness engines, expected usage, dual Scope 2 carbon engine, trends, targets, projects, Decarb/CRREM action plans and optimiser, EPC risk, SFDR/GRESB outlier, climate-risk stub, bulk import, meter-data connector (Perse withdrawn Sep 2026, D-4) | 10 weeks, 7 phases |
| Portfolio Intelligence (Arbnco parity) | Fund→asset→unit→meter, tenant-meter consent workflow, water, data sources screen, map, calendar, MCP skill feed | Target Jan 2027 |
| NZC AI sidecar | Claude Agent SDK service: assistant chat, nightly missing-document flagging, fault detection, regulatory guidance monitor; 14 scoped tools; audit log | 9–14 weeks |
| EPC register + MEES engine + mapping | Non-domestic EPC API lookup, MEES rules incl. 2031 EPC B, satellite hero map, pins, Solar fix | Briefed Aug 2026 |
| Local-first engine | FastAPI + Supabase + Ollama on EVO-X2; deterministic engines; RAG over skill references; 30-skill advisory library | In progress |

### 3.3 Genuine differentiators (already real, in the skills and consultancy)

- Regulated, accredited human sign-off (ESOS lead assessor, NZCBS, CRREM, MEES, TM44, WLCA).
- UK-native compliance depth: ESOS Phase 4 and MESOS field-level knowledge, MEES with the June 2026 DESNZ position, NZCBS V1 Rev 1 proforma, CRREM V2.07, GRESB 2026, SECR, TCFD/UK SRS.
- Building engineering: energy audits with NPV/SPP, burn-cycle optimisation, PV design and PPA billing, solar microgeneration.
- Branded investment-grade report production (NZC Portal and Focus Green house styles).
- Local data sovereignty story (client data never leaves the EVO-X2).
- Price point an order of magnitude below Watershed.

---

## 4. Lessons: why Welcome Break picked Watershed

### 4.1 The client and the stated reason

Welcome Break operates some 60 locations including 32 motorway service areas and 31 hotels, with 6,000+ staff and 85 million customers a year. On its sites it is simultaneously a franchisee (KFC, Starbucks, Burger King, Taco Bell, Subway, Greggs, Pret, PizzaExpress, Krispy Kreme, Chopstix), a retail partner (Waitrose, WHSmith), a hotel franchisee (Ramada, Days Inn), a landlord to concession and charging tenants (Tesla, GRIDSERVE, Revolution Laundry) and a fuel and EV-charging retailer. Its parent, Applegreen (Dublin, €3.85bn revenue 2025, ~15,000 staff, owned by Blackstone Infrastructure and B&J Holdings), has a net-zero 2050 goal across Scopes 1 to 3, has completed a first Scope 3 assessment and is building an SBTi-aligned transition plan.

The stated reason, from their ESG manager, was blunt: **"you are weak on Scope 3."** Pressed further, the substance was that NZC AI records ledgers and basic in and out. It is a two-dimensional recording system, and the whole difficulty in Scope 3 is the data you do not yet hold: who has it, whether you have asked, what came back, whether it is any good, and who is asking you for the same thing. Three obligations converge on that:

| Driver | Requirement | What Welcome Break needs |
|---|---|---|
| CSRD Wave 2 (Applegreen exceeds 1,000 employees and €450m turnover) | First statement in 2028 covering FY2027 under ESRS 2.0; E1-6 gross Scope 3 by category with a primary/secondary data split; limited assurance | An assurable category-level inventory from the UK entity, baseline year FY2026 |
| SBTi criterion C22 | Fuel sellers must set a separate 1.5°C category 11 target; near-term targets must cover 67% of Scope 3; exclusions under 5% | Fuel sold quantified as a mandatory line; food and packaging (category 1) almost certainly in the boundary |
| Franchisor targets (Yum! Brands 46% per-restaurant reduction by 2030 with franchisees; Starbucks and Wyndham similar) | Annual restaurant-level energy, waste and packaging data requests | Reporting upward to brands and sideways to the parent from one dataset |

Extra MSA, a direct peer, became the first motorway service operator with SBTi-validated net-zero targets in 2025. That raised the bar for Welcome Break's board.

NZC Portal could not answer any of that. The GHG skill covers categories 1, 3, 5, 6 and 7 for organisations holding their own data; there is no spend-based engine, no operator-role boundary logic, no partner data collection, no data-quality tiering and no ESRS or SBTi output. Watershed covers all 15 categories with CEDA, supplier engagement and a CSRD builder, and sells an assurance guarantee on top.

There is one thing Watershed does not do either, and it is half of Welcome Break's actual workload. Every platform in this market models the client as the *requester* who sends suppliers a survey. Welcome Break is also the *requested*: Yum! Brands, Starbucks and Wyndham demand per-restaurant data from it, Applegreen demands category-level Scope 3 for the CSRD consolidation, and its lenders demand ESG KPIs. The leverage runs the wrong way with a franchisor — Welcome Break cannot compel Yum! to disclose, but Yum! can compel Welcome Break. A Request Inbox that answers inbound obligations from one governed dataset is unclaimed territory, and it is the wedge back into this account.

### 4.2 The wider lessons

1. **Completeness beats depth at selection time.** A buyer runs two demos. Watershed shows a finished product covering the whole company. NZC Portal shows a strong ESOS data hub with a wrong deadline countdown, missing floor areas in the demo org, "coming soon" on the evidence pack and no occupier portal. Depth in the skills library is invisible in that meeting.
2. **Buyers buy assurance, not calculations.** Watershed's headline is lineage, approval workflow, annual assured methodology and a money-back assurance guarantee. Nothing in NZC Portal's UI shows a number's provenance, even though the design has an evidence trail.
3. **Group-level scope.** If the client is an operating company or a fund's management company, their reporting obligation is the corporate footprint (CSRD/UK SRS/CDP/SBTi), not the buildings. NZC Portal is a real-asset tool and has no Scope 3 spend-based engine, no supplier module and no CDP/CSRD builder.
4. **Risk of the small vendor.** No SOC 2, no ISO 27001, no trust page, no named customers, no analyst coverage, one developer. Procurement and the audit committee see that before they see the functionality.
5. **The AI story.** Watershed's 2026 launches are all AI agents, drafting and OCR, with a customer AI fellowship. NZC AI has the better raw material (30 expert skills, a deterministic engine, local inference) but nothing a prospect can click.
6. **Sales motion.** Named references, case studies with quantified outcomes, a weekly customer-success cadence, a learning hub, Big Four implementation partners. NZC sells consultant-to-client.
7. **Integrations.** "60+ integrations" versus CSV. Even if the client only uses three, the list signals maturity.
8. **A defined pricing story.** Watershed is expensive but the buyer knows what they are getting: platform plus advisory plus assurance support. NZC Portal has Stripe subscriptions but no public tiers or packaging.

The honest self-assessment: Welcome Break needed a Scope 3 system NZC does not yet have, and even where NZC is strong the product was not finished enough, or credentialed enough, to be considered for the site-level work.

### 4.3 What this means for the roadmap

The Scope 3 gap moves from Tier 3 to Tier 2, and splits into two layers built in parallel.

**Layer 1, the ledger** (ten weeks): outlet operator roles that set the boundary automatically, purchase-ledger import with EEIO mapping on Open CEDA and DESNZ, physical activity data for food, packaging, fuel sold and waste, data-quality tiers with the ESRS primary/secondary split, SBTi coverage tests with the mandatory category 11 flag, franchisor packs, consolidation to a parent. Reuses the ECR ledger for categories 8 and 13.

**Layer 2, engagement and document intelligence** (eleven weeks): the answer to "weak on Scope 3". A counterparty graph where one entity holds several roles at once, an engagement state machine per relationship per period, a public-first enrichment pipeline that harvests reports, CDP, SBTi and EPD registries so requests arrive pre-filled, typed documents with extraction schemas and validity windows that re-open a chase automatically when a certificate expires, conflict detection against a counterparty's own published figures, a chase engine back-planned from the deadline with a contact escalation ladder and cross-client fatigue control, machine exchange over PACT and VSME, a Request Inbox that answers franchisor and parent obligations from the same dataset, and an agent fleet that finds, drafts, reads and reconciles while the deterministic engines compute and a human approves.

Three external developments make the timing right: PACT's v3.0.3 REST API means product footprints can arrive machine-to-machine with native data-quality fields, SBTi's Net-Zero Standard V2 turns supplier engagement into a target type with a 2030 deadline for food-intensive suppliers, and EFRAG's free VSME template and XBRL converter give SMEs a format they can fill once for everyone.

---

## 5. Capability gap matrix

Legend for "NZC today": **Live** (deployed), **Partial** (deployed with gaps), **Spec** (written brief, not built), **Skill** (exists as consultancy skill, not in product), **None**. Gap severity: **Critical** (loses deals now), **High** (expected within 12 months), **Medium**, **Low** (not our market).

| Capability | Watershed | NZC today | Severity | Action |
|---|---|---|---|---|
| Scope 1 and 2, dual Scope 2 | Full | Skill; ECR WS4 Spec | Critical | Ship carbon engine over the ledger (ECR P3) |
| Scope 3 activity-based (cat 3, 5, 6, 7, 13) | Full, 15 categories | Skill (GHG report) | High | Product-ise via ECR carbon engine; occupier portal |
| Scope 3 spend-based (cat 1, 2) | CEDA EEIO | None | High | Open CEDA + DESNZ; Xero/Sage/QuickBooks spend import |
| Emission-factor management | Versioned library with metadata | Factor selector "no versions configured" | Critical | Ship DESNZ/DEFRA sets by year as managed reference data |
| Utility bill OCR | AI, GA 2026 | PDF extraction in engine (local) | High | Wire extraction into portal readings with confidence flag |
| Meter data connectors | Arcadia/Urjanet | None | High | **Open.** Perse withdrawn Sep 2026 (D-4); no replacement chosen |
| Finance/HR integrations | 60+ | None | High | Accounting packages first; HR later |
| Data quality checks | 150+ checks, issue queue | Spec (ECR WS3) | Critical | ECR P2 |
| Lineage / audit trail in UI | Full, auditor access | Design only; Review Centre in ESOS | Critical | "Audit" screen + change-log export |
| Approval workflow / data lock | Yes | ESOS Review Centre only | High | Generalise Review Centre to all modules; phase lock on notification |
| Multi-entity / group | Multiple footprints per org | Flat organisation | High | Legal entity + group model (ESOS B1–B3) |
| CSRD/ESRS builder | Product | Skill | Medium | Later; UK mid-market rarely in scope |
| ISSB / UK SRS / TCFD | Builder | Skill; landlord TCFD Spec | Medium | Narrative generation from ledger via skill |
| CDP | Gold-accredited, API sync | None | Medium | Export mapping later |
| SECR | Spreadsheet export | Live module (needs hardening) | Parity | Harden; add statement generation |
| ESOS / MESOS | Marketing mention only | Live, 6/34 met | NZC advantage if fixed | P1 fix list from 19 Aug review |
| EPC / MEES | None | Live (manual); register API Spec | NZC advantage | Build EPC register + MEES engine (Aug brief) |
| CRREM / stranding | None | Skill; Decarb Spec | NZC advantage | ECR P5 |
| NZCBS | None | Skill; proforma schema | NZC advantage | Portal proforma module |
| GRESB | None | Skill | NZC advantage | GRESB outlier + Asset Portal export (ECR P6) |
| Landlord / tenant boundary, consent | None | Portfolio Intelligence Spec | NZC advantage | Phase D consent workflow |
| Half-hourly / interval analytics | None | Spec | NZC advantage | Half-hourly storage and load profiles; source open since Perse withdrawn (D-4) |
| Energy audit, measure NPV/SPP | None | Skill | NZC advantage | Projects registry unified with audit outputs (ECR P4) |
| Solar PV design, PPA billing | None | Skill; microgen prototype | NZC advantage | Complete microgeneration; fix Solar API |
| Targets (SBTi, CRREM, custom) | SBTi/FLAG | Spec (ECR WS6) | High | ECR P4 with SBTi 4.2%/yr and CRREM-derived |
| Decarbonisation scenarios | Scenario modelling, ROI | Retrofit what-if in engine; Decarb Spec | Medium | ECR P5 |
| Supplier engagement (outbound) | Portal, surveys, 20M firm database, EcoVadis | None | Critical | Layer 2: enrichment-first requests, tiering, chase engine, PACT/VSME exchange |
| Inbound data requests (Request Inbox) | **None** | None | NZC advantage | Layer 2 §11.1 — unclaimed by every vendor in this market |
| Document intelligence and provenance | Lineage on ingested data | PDF extraction in engine | Critical | Layer 2: typed documents, validity, conflict detection, confidentiality |
| Clean power / REGO / PPA instruments | EAC allocation, VPPAs | Spec (instruments in ECR) | Medium | Instrument tracking zeroes MB Scope 2 (acceptance test 4) |
| Carbon removal marketplace | 30+ projects | Offset schedule skill | Low | Partner referral, not a build |
| Physical climate risk | Via partners (Finance) | Spec stub | Low | EA open flood data free tier |
| AI assistant / agents | Agents, drafting, Q&A | Sidecar Spec | Critical | Sidecar Phase 0–2 |
| AI missing-data flagging | Gap-fill agents | Sidecar Spec | High | Sidecar Phase 1 |
| Regulatory monitoring | Policy team, inline guidance | Sidecar Spec | Medium | Sidecar Phase 4 |
| Branded report generation | AI drafting into builders | Skills (docx) | NZC advantage | One-click packs from ledger with sign-off gate |
| Peer benchmarks | 10k–30k disclosures | None | Medium | CIBSE TM46, REEB, NZCBS limits, NZC pool percentiles |
| Map / portfolio view | None | Spec | NZC advantage | Mapping module (Aug brief) |
| Security attestation | SOC 2 Type II, trust centre | None | Critical | Cyber Essentials Plus, then ISO 27001; trust page |
| Data residency | EU GA | UK local-first (EVO-X2) | NZC advantage | Make it a documented, auditable claim |
| SSO / SCIM | Yes | Unknown | High | SSO for fund clients |
| API / docs | Customer-only | None | Medium | Public OpenAPI for ECR read model |
| Multi-currency | Automatic | GBP only | Low | FX table when needed |
| Implementation / CSM | Advisory, weekly CSM, learning hub | Consultant-led | Medium | Onboarding checklist in product; help centre |
| Pricing transparency | None (custom) | Stripe, no tiers | Medium | Publish three tiers |
| References, analysts | Many | None | Critical | Three case studies; Verdantix briefing |

---

## 6. Where NZC should not compete

- **Global Scope 3 breadth, PCFs, financed emissions.** Watershed has 21 scientists and a factor library it gives away. Use Open CEDA rather than building factors.
- **Removal marketplace and VPPAs.** Refer to partners; the offsetting skill already advises.
- **CSRD as a primary product.** UK mid-market and CRE clients are largely out of scope; keep it a skill.
- **US disclosure rules.** Not our market.

---

## 7. What to build to compete — prioritised plan

The ordering principle: first remove reasons to say no, then ship the things Watershed cannot do, then add parity features where clients actually ask.

### Tier 1 — remove reasons to say no (next 90 days)

| # | Item | Source spec | Notes |
|---|---|---|---|
| 1.1 | Fix the ESOS P1 list: NoC preparer, statutory calendar and deadline engine, Reg 34A fields, 12-month reference period, factor sets, director sign-off | ESOS/MESOS gap analysis 19 Aug | Never demo the current deadline countdown again |
| 1.2 | Demo organisation with complete, correct data | Same, Section 8 | Floor areas, addresses, real Phase 4 dates, verified records |
| 1.3 | Data-quality engine and issue queue | ECR WS3, P2 | Gaps, end gaps, overlaps, completeness %, floor-area coverage, outliers, expected usage with method label |
| 1.4 | Audit screen: lineage from every reported number to reading, bill or connector payload; change log export | ECR audit trail, ESOS J1/J2 | Make the existing evidence trail visible |
| 1.5 | Managed emission-factor sets (DESNZ 2024, 2025, 2026) with version stamp on every calculation | ESOS C3 | Also unblocks SECR statement |
| 1.6 | Security: Cyber Essentials Plus, pen test, trust page, DPA with Anthropic as sub-processor, ISO 27001 project started | System Design §7 | Procurement gate |
| 1.7 | Three named case studies and a references page | — | Lynx microgeneration, an ESOS Phase 3 client, a MEES tracker client |
| 1.8 | Published pricing tiers | — | e.g. Compliance (ESOS/SECR/MEES), Portfolio (landlord ledger + CRREM/NZCBS), Enterprise (occupier + Scope 3 + AI); consultant white-label tier |

### Tier 2 — ship what Watershed cannot (3–9 months)

| # | Item | Source spec |
|---|---|---|
| 2.1 | ECR ledger P1, P3–P6: hierarchy, meter ledger, dual Scope 2 carbon engine, trends, targets, projects, Decarb/CRREM action plans, EPC risk, GRESB outlier, exports | ECR brief |
| 2.2 | EPC register API + MEES risk engine with 2031 EPC B and gas-risk flags; portfolio map with status rings | Dev brief 14 Aug |
| 2.3 | Half-hourly storage and load profiles. **Perse withdrawn Sep 2026** (D-4); data source to be re-chosen | ECR WS14 |
| 2.4 | Tenant-meter consent workflow and landlord/occupier perspective flip | Portfolio Intelligence Phase D |
| 2.5 | One-click branded packs from the ledger: ESOS pack, SECR statement, NZC assessment, GHG report, GRESB workbook, TCFD narrative, with human sign-off gate | ECR §17 item 8 |
| 2.6 | NZC AI sidecar Phase 0–2: chat with citations, nightly missing-document flags | System Design |
| 2.7 | PDF bill OCR wired into readings with confidence and one-click accept | ECR X4 |
| 2.8 | Microgeneration completion incl. Solar API fix and PPA billing | Hidden Brains Phase 3; microgen skill |
| 2.9 | NZCBS proforma module mirroring rev03 workbook | nzcbs-standard skill |
| 2.10 | Scope 3 Layer 1: outlet roles, ledger import and EEIO mapping, activity data, quality tiers, ESRS E1-6 and SBTi outputs, franchisor packs | Scope 3 brief (docs/product) |
| 2.11 | Scope 3 Layer 2: counterparty graph, engagement lifecycle, public-first enrichment, document intelligence, chase engine, Request Inbox, PACT and VSME exchange, agent fleet | Scope 3 engagement brief (docs/product) |

### Tier 3 — parity where clients ask (9–18 months)

| # | Item |
|---|---|
| 3.1 | Scope 3 extensions: commercial ingredient factor database, distributor feed connectors, supplier scorecards, product-level footprints |
| 3.2 | SBTi target module with progress tracking; CRREM-derived and NZCBS-derived pathways as target lines |
| 3.3 | REGO/PPA instrument tracking with market-based Scope 2 allocation |
| 3.4 | UK SRS/TCFD and CDP export mapping from the ledger |
| 3.5 | Supplier survey lite (Scope 3 cat 1 data requests) reusing the RFI portal |
| 3.6 | SSO/SCIM; public OpenAPI for the ECR read model |
| 3.7 | UK benchmark percentiles (CIBSE TM46, REEB, NZCBS limits, anonymised NZC pool) |
| 3.8 | Sidecar Phases 3–4: fault detection, regulatory guidance monitor |
| 3.9 | Watershed export adapter: clean building-level Scope 1/2 and category 13 data as a CSV a Watershed customer can ingest |

### Capacity reality

The ECR brief alone is ten weeks; the sidecar is nine to fourteen; the Hidden Brains proposal quotes £7k for discovery and roughly £5k per developer-month thereafter. Tier 1 needs one Rails developer plus James for six to eight weeks. Tier 2 needs the engine team in parallel. Sequencing matters more than headcount: nothing in Tier 2 should ship to a prospect before Tier 1 items 1.1, 1.2 and 1.4 are done.

---

## 8. Positioning and go-to-market lessons

1. **Position as the real-asset layer, not a Watershed alternative.** "Watershed tells the board the group number. NZC Portal makes the buildings and the UK obligations behind that number defensible." That framing turns a lost deal into an adjacent one.
2. **Lead with assurance language.** Every screen: factor version, source, reviewer, date. Copy Watershed's vocabulary ("lineage", "approval", "locked") because auditors already use it.
3. **Make the AI visible.** A chat panel grounded in the client's own ESOS record and citing the regulation beats any agent demo Watershed can give on UK compliance. Build Phase 2 of the sidecar before anything else in AI.
4. **Sell the sign-off, not the software.** Watershed cannot put a lead assessor's name on a Notification of Compliance or verify NZCBS alignment. Bundle accredited sign-off into the Portfolio and Enterprise tiers.
5. **An assurance-style guarantee.** Watershed waives up to $250k if assurance fails. An NZC equivalent: "If the Environment Agency rejects a notification prepared in the portal, remediation is free." Cheap to offer, strong signal.
6. **Publish pricing.** Watershed's opacity is a weakness reviewers cite; a clear £/site/year page wins mid-market.
7. **Partner channel.** Watershed uses Deloitte and KPMG. NZC's equivalents are managing agents, EPC assessors, energy brokers and regional accountancy firms. A consultant white-label tier is the route to volume.
8. **Get into the analyst set.** Verdantix runs a Green Quadrant for real-estate ESG software; a briefing costs time, not money.
9. **Marketing must match the build.** The public site claims lineage, versioning and exportable report packs. Until Tier 1 is done, a demo will contradict the website, which is worse than a modest website.
10. **Instrument the loss.** Ask the client for a 20-minute loss review and record it. This document should be updated with their actual reasons.

---

## 9. Win-back and coexistence play for Welcome Break

Watershed will hold the group Scope 3 inventory and feed Applegreen's CSRD statement. It will not do Welcome Break's ESOS Phase 4 notification (Welcome Break qualifies on headcount; notification due 5 December 2027), MEES exposure for 2031 EPC B across 32 service areas and 31 hotels, site energy engineering, shared-energy allocation to outlets for franchisor packs, or the landlord/concession split for category 13. Offer:

1. **ESOS Phase 4 lead assessor engagement** run through the portal, with the evidence pack and MESOS transcription export. The energy audit outputs also give Watershed better Scope 1/2 data than bill OCR.
2. **Site energy ledger with outlet allocation** so per-restaurant energy and waste intensities for Yum!, Starbucks and Wyndham requests come from meters, not estimates. Watershed does not allocate shared site energy to outlets.
3. **Category 13 concession data via the consent workflow** (Tesla, GRIDSERVE, laundry, retail concessions) exported in a form Watershed can ingest.
4. **MEES/EPC tracker** for the estate, with the 2031 exposure list and lease-event triggers; hotels included.
5. **Solar PV and EV-load design** for the larger sites, feeding the transition plan Applegreen is writing.

Price these as consultancy plus a Compliance-tier subscription. The goal is to stay inside the account as the site-level system while Watershed holds the corporate ledger, and to use the engagement as the design-partner seed for the Scope 3 module. Ask Welcome Break's ESG team for a 20-minute loss review; this document should carry their actual words.

---

## 10. Sources

**Watershed (vendor, via cached crawl)**
- https://watershed.com/en-GB · /en-GB/platform · /en-GB/platform/measure · /en-GB/platform/act · /en-GB/platform/climate-disclosures/secr · /platform/sustainability-ai · /platform/marketplace · /platform/disclosures/csrd · /solutions/finance · /solutions/california/guaranteed-assurance · /security · https://trust.watershed.com · /customers · /about-us
- Product updates: /blog/productupdatesdecember2024 · /blog/productupdatesjan2025 · /blog/product-updates-q2-25 · /blog/product-updates-q3-25 · /blog/2026-measurement-release · /blog/product-footprints · /blog/ai-reporting-esg · /blog/ai-agents-fellowship · /blog/cdp-2026-now-available-in-watershed · /blog/500m-clean-energy · /blog/uk-srs-guide · /blog/series-c · /blog/royalmail · /blog/ecovadis-partnership · /blog/deloitte-partnership
- Customer stories: /en-GB/customers/smithsgroup · /en-GB/customers/skyscanner · /customers/monzo-mission-to-bring-carbon-transparency-to-banking

**Analysts and press**
- Verdantix Green Quadrant Carbon Management 2026 press release (GlobeNewswire, 11 Mar 2026)
- Forrester Wave Sustainability Management Software Q2 2024
- IDC MarketScape Carbon Accounting Management 2026
- GlobeNewswire 21 Apr 2026 (agents), 23 Sep 2025 (Product Footprints); ESG Today coverage of both
- nationaltechnology.co.uk on the London co-HQ

**Pricing and reviews (third-party, directional)**
- Vendr marketplace listing; Dcycle Watershed pricing; rfp.wiki; ERP Research; StackMatch; sustainabilityreportingstandards.co.uk; uksrs.org.uk buyer's guide; Greenly vs Watershed; Sweep vs Watershed
- Tracxn, DealData (Form D Dec 2025), Forge, PitchBook, LinkedIn, trueup.io for funding and headcount

**Welcome Break and Applegreen**
- welcomebreak.co.uk/brands · Forecourt Trader on the MSA network commitment (32 sites) · Applegreen 2025 growth statement (applegreengroup.com) · drivechange.applegreen.com (net-zero 2050, first Scope 3 assessment) · Irish Times 26 Nov 2025 (revenue) · Blackstone/B&J Holdings takeover announcement · Extra MSA 2025 Sustainability Report (SBTi validation) · Yum! Brands climate targets · SBTi Corporate Near-Term Criteria V5.3.1 (C4, C6, C22) · csrd-advisory skill (Omnibus I thresholds and Wave 2 timing)

**NZC internal**
- nzcportal.co.uk home, platform and EPC/MEES pages
- Hidden Brains, NZC Portal Proposal & Delivery Approach V1.0 (25 Aug 2026)
- NZC Portal ESOS Module: ESOS Phase 4 & MESOS Compliance Gap Analysis (19 Aug 2026)
- NZC Portal Development Brief: Mapping, EPC & MEES, Google Solar fix (14 Aug 2026)
- NZC AI System Design & Build Roadmap (10 Jul 2026)
- NZC AI Feature Brief: Energy & Carbon Reporting Platform (29 Aug 2026)
- NZC AI Feature Brief: Portfolio Energy & Carbon Intelligence
- NZC AI Architecture & Strategy (source of truth)
- NZC AI Competitor Landscape (29 Aug 2026)

*Watershed's own domain was blocked from this environment; vendor pages were read through a cached crawler and may lag the live site. Pricing figures are third-party and should be treated as ranges, not quotes.*
