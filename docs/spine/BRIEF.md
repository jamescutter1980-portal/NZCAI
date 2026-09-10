# NZC AI: Feature Brief for Claude Code
## Data Spine: one dataset, quality tiers, cited lineage

**Brief ID:** NZCAI-FB-2026-09-10-SPINE
**Source:** Watershed competitor scan, 10 Sep 2026. Lift items W-11 (measure once, disclose everywhere), W-03 (data-quality score at every level) and W-23 (lineage and cited AI)
**Workstream:** NZC AI only (`C:\nzc-group-ai`, engine repo + frontend repo). **Not NZC Portal.**
**Owner:** James Cutter · **Build agent:** Claude Code (orchestrator), with Codex/Ollama sub-agents
**Keep in repo as:** `docs/spine/BRIEF.md`
**Status:** Ready to build. Target: green before the January 2027 release.

> **Filing note, 10 Sep 2026.** Filed verbatim from the source Google Doc, with only Google Docs' markdown escaping removed. See `AUDIT.md` for the S0 discovery result and `DECISIONS.md` for what was decided and what is escalated. Three conflicts with the existing Scope 3 briefs are recorded in `DECISIONS.md` and are not resolved in this file.

---

## 0. How to use this brief

1. Read this file top to bottom before touching code. §1–2 explain what and why, §3 lists the hard constraints, §4 is the discovery step (do it first), §5–8 are the build phases, and §9 is the acceptance test you self-verify and report against.
2. This brief **sits on top of** the Energy & Carbon Reporting brief (`docs/ecr/`, NZCAI-FB-2026-08-29-ECR) and the Portfolio Intelligence brief (Arbnco parity). It does not replace their ledger, integrity, completeness or expected-usage engines. It adds what they lack:
   - a single source of truth for **every** reportable figure, not just meter readings;
   - a quality tier on every figure;
   - a proof chain from every number and sentence in a report back to its evidence.
3. Work in small commits on `feat/spine-s<N>`. Keep CI green after every task: existing deterministic-engine tests, skill golden files and the E2E critical path must all still pass.
4. Ask James only when a decision is irreversible (see §4). Otherwise choose the option that fits §3, record it in `docs/spine/DECISIONS.md` and carry on.

---

## 1. Why this matters

Today NZC AI produces strong per-report outputs. The same figure (floor area, total kWh, headcount, turnover) can still be entered or extracted separately for SECR, ESOS, CRREM, GRESB and NZCBS. That creates three risks:

- **Inconsistency.** One report says 16,104 m² and another says 16,140 m².
- **Unclear confidence.** A reviewer can't see which figures are metered, which are estimated and which are benchmarks.
- **Unverifiable AI text.** Narrative from the local LLM can quote a number or a regulation that nothing traces back to.

Watershed's main selling points answer exactly these: data entered once and reused everywhere, a quality score at every level, and "every number traceable, AI output with cited sources". NZC AI's version must be **UK-specific, run entirely locally, and be deterministic**.

**Outcome:** any figure in any NZC AI report can be clicked. It shows where the figure came from (reading, bill page, register record, RFI answer, factor row), how it was calculated (engine, version, inputs), how good it is (tier) and which other reports use it. A change to any input marks every affected draft as stale.

---

## 2. Scope

**In scope**

- S1: metric dictionary, datapoint store, resolver and framework map (W-11)
- S2: quality tiers, roll-ups and framework-facing quality outputs (W-03)
- S3: calculation lineage, report dependencies and staleness, cited narrative with validator, lineage drawer, evidence appendix (W-23)
- S4: move the remaining report skills onto the resolver, with an architecture test that enforces it

**Out of scope** (later briefs; don't build, but leave clean hooks)

- W-01 bulk bill scanner and W-02 data-cleaning agent. They will call `spine.ingest_datapoints()`, so design that function for them.
- W-12 roll-forward of last year's answers
- Anything in NZC Portal, the MCP layer to the Portal, or Rails
- Any paid data source. **Perse is out** (direction changed Sep 2026). Ignore Perse sections of the ECR brief.

---

## 3. Non-negotiables

1. **No LLM in any calculation path.** Tiers, roll-ups, lineage, staleness and narrative validation are deterministic Python with golden-file tests.
2. **Reuse, don't duplicate.** Extend what already exists:
   - the evidence/audit-trail middleware and tables
   - the ECR/Portfolio Intelligence ledger (readings, `estimated_share`, `expected_usage` + `expected_method`, integrity issues)
   - the PDF extraction → RFI field feature
   - the client RFI portal
   - EPC/TM44 register retrieval
   - the factor store (DESNZ/DEFRA by year, CRREM V2.07)
   - the report sign-off gate

   Meter readings **stay in the ledger**. The spine refers to them; it never copies them.
3. **Framework field IDs come from the skill reference files, never from memory:**
   - MESOS field names and option lists: `mesos-notification`
   - GRESB indicator codes: `gresb-advisory`
   - SECR requirements: `secr-report`
   - CRREM inputs: `crrem-analysis`
   - NZCBS: `nzcbs-standard`
   - TCFD: `tcfd-advisory`

   If a field ID isn't in a skill file, mark the mapping unverified and list it in `STATUS.md`. Don't guess.
4. **Client data stays local.** Local Ollama for narrative only. DeepSeek never receives client data, datapoints, citations or evidence. The Anthropic API is reserved for the regulatory-watch agent.
5. **Human sign-off stays.** Every generated report keeps the "requires qualified sign-off" gate. Signed-off report versions are **immutable**; a change means a new version.
6. **Append-only history.** Datapoints are never updated in place. A correction creates a new version with `supersedes_id`. Deletes are soft deletes via the audit middleware.
7. **RLS on every new table**, keyed on organisation membership. Roles: Super Admin · Consultant (multi-client) · Consultant single-company · Business Admin · Business Viewer (read + export only).
8. **Follow repo conventions.** Use the existing DB access layer, auth dependency, router mounting, Tailwind/shadcn tokens and TanStack Query. No new ORM or state library.
9. **Number formatting** follows the existing convention: kWh 0 dp with thousands separators; tCO₂e 2 dp; kWh/m² 1 dp; kgCO₂e/m² 2 dp; **NA for unknown, never 0 or blank**. The validator (§7) uses these same rules.
10. **GDPR.** Lineage stores who uploaded, approved and edited what. If the GDPR stage is still open, finish it first and apply its retention rules to the new tables.

---

## 4. S0: Discovery (do this first, commit before any code)

Grep both repos and write `docs/spine/AUDIT.md` answering:

| # | Question | Record |
|---|---|---|
| 1 | Which ledger exists: `ecr` schema, `cr_*` tables, both or neither? How much data does each hold? | Table list + row counts |
| 2 | Evidence/audit-trail: table names, columns, and how a write is attributed (who/when/source/before/after) | Schema excerpt |
| 3 | RFI portal: where are answers stored? Do they carry the evidence document and responder? | Schema excerpt |
| 4 | PDF extraction: output shape. Does it keep page number / bounding box per field? | Example payload |
| 5 | Factor store: how a factor set is versioned and referenced | Schema excerpt |
| 6 | For each report skill in NZC AI (SECR, ESOS/MESOS, GRESB, CRREM, NZCBS, TCFD, GHG, MEES, EPC): where does it read its inputs today? | One row per skill: source tables / RFI keys / hard-coded |
| 7 | How the sign-off gate works and what it stores | Flow description |
| 8 | Current narrative generation: prompt location, model, post-processing | File paths |

**Decision rules**

- One ledger exists → build on it.
- Neither exists → build the spine against RFI + evidence tables now. Leave `ledger_ref` columns nullable and note it.
- **Both exist with real data → STOP and ask James.** Merging ledgers is irreversible. Everything else: decide and log.

---

## 5. S1: One dataset, used everywhere (W-11)

### 5.1 Data model (Supabase migrations, schema `spine`)

Sketch only. Adapt names to repo conventions and log any deviation.

- **`spine.metric`**: the metric dictionary.
  - Columns: `code` (e.g. `floor_area_gia`, `elec_grid_kwh`, `gas_kwh`, `fleet_fuel_litres`, `headcount_fte`, `turnover_gbp`, `refrigerant_charge_kg`, `epc_band`, `company_number`, `uk_sic_code`), `label`, `dimension`, `canonical_unit`, `entity_level` (org | fund | asset | unit | meter), `value_type` (numeric | text | enum | date), `period_type` (instant | period), `aggregation` (sum | weighted_avg | latest | none), `allowed_sources`, `ledger_backed` (bool).
  - Seed from the inputs the report skills actually use (AUDIT.md row 6), not from a generic list.
- **`spine.datapoint`**: every non-ledger figure.
  - Columns: `id`, `org_id`, `entity_type`, `entity_id`, `metric_code`, `period_start`, `period_end` (half-open, same convention as ECR), `value_num` | `value_text`, `unit_as_entered`, `value_canonical`, `source` (ui | rfi | pdf_extraction | register | bulk_import | calc | benchmark), `source_ref`, `evidence_document_id`, `evidence_locator` (page/bbox/cell), `method_label`, `tier` (§6), `supersedes_id`, `status` (active | superseded | rejected), `created_by`, `created_at`.
- **Ledger-backed metrics** (energy by fuel, water) are **not** stored as datapoints. The resolver computes them from the ledger through the ECR engines and returns a `calc_run` (§7).
- **`spine.framework_field`**: the framework map.
  - Columns: `framework` (SECR | ESOS_NOC | ESOS_ACTION_PLAN | GRESB | CRREM | NZCBS | TCFD | GHG), `field_id` (exact ID from the skill reference), `label`, `metric_code` or `formula_ref`, `entity_level`, `required` (bool / conditional expression), `skill_source_path`, `verified` (bool).

### 5.2 Resolver (the only way reports read data)

```
resolve(org_id, entity_ref, metric_code, period, *, basis="location"|"market",
        perspective="landlord"|"tenant") -> ResolvedValue
# ResolvedValue: value, unit, display (formatted per §3.9), tier, tier_mix,
#   datapoint_ids[], calc_run_id | None, evidence[], stale: bool, conflicts[]
```

- One active datapoint → return it. Several conflicting active datapoints for the same metric/entity/period → return the highest-tier one, list the others in `conflicts[]` and raise a data issue (reuse the ECR issues queue).
- Nothing found → return NA with `tier=None`. **Never return 0.**
- `resolve_framework(org_id, framework, period)` returns every framework field with its value or a gap reason.

### 5.3 Framework coverage → RFI requests

- A **Coverage** view per organisation, framework and period shows fields resolvable / required, grouped by gap reason: missing, below required tier, or conflict.
- "Request missing data" creates RFI portal items for each missing metric, with the evidence type needed. **Idempotent**: re-running never duplicates open requests.
- Pilot on **SECR** and **ESOS Notification of Compliance** first. Both are organisation-level, and the ESOS NoC dataset was the largest gap in the 19 Aug 2026 ESOS review.

### 5.4 Ingest API (hook for W-01 / W-02)

```
spine.ingest_datapoints(batch: list[DatapointIn], source, source_ref, actor) -> IngestResult
```

- validates unit/dimension against `spine.metric`
- normalises to the canonical unit
- assigns a tier (§6)
- writes through the audit middleware
- returns created / superseded / rejected with reasons

The existing PDF → RFI extraction and RFI portal submissions must write through this function by the end of S1.

---

## 6. S2: Quality tiers at every level (W-03)

### 6.1 Tier model (deterministic assignment from source + flags)

| Tier | Name (UI) | Assigned when |
|---|---|---|
| A | Measured | Actual meter read; invoice actual read; connector actual; register-lodged record (EPC/TM44/DEC) |
| B | Supplier estimate | Invoice or connector flagged as an estimated read |
| C | Calculated | Deterministic estimate from the client's own data: ECR `expected_usage` gap-fill, pro-rata, degree-day adjustment, sub-meter apportionment, part-year extrapolation. `method_label` is required. |
| D | Benchmark | External benchmark or proxy: CIBSE TM46 / REEB intensity × area, spend-based factor, typical-asset assumption. The benchmark source and year are required. |
| U | Declared | A client statement with no evidence document (RFI answer without an attachment) |

- Rules live in `spine/engines/tiers.py` as a single table-driven function with golden tests for every source × flag combination.
- A reviewer can **downgrade** a tier with a reason. **Upgrading** needs attached evidence. Both are audited.

### 6.2 Roll-ups

- `spine/engines/quality.py` rolls up meter → unit → asset → fund → org:
  - additive metrics: **kWh-weighted** tier mix (for ledger metrics, reuse ECR's monthly `estimated_share`)
  - non-additive metrics: count-weighted
- Outputs per entity and period:
  - `tier_mix` (% A/B/C/D/U)
  - `evidence_backed_pct` (A+B)
  - `completeness_pct` (reuse the ECR completeness engine, don't recompute)
  - `open_conflicts`
- Property tests: tier-mix percentages always sum to 100 ±0.01; roll-up of roll-ups equals a direct roll-up.

### 6.3 Where the tiers show up

- **Report cover "Data confidence" panel**: tier mix, evidence-backed %, completeness %, count of Declared items.
- **SECR methodology section** gets an engine-generated list of estimation methods used, with the share of energy each covers.
- **ESOS NoC**: estimation flags derived from tiers, using the exact field names and rules in the `mesos-notification` skill.
- **GRESB**: data-coverage inputs per the `gresb-advisory` skill reference.
- Thresholds (e.g. "warn if Declared > x%") are **configuration**, not code.
- A tier badge appears next to every figure in the review UI.

---

## 7. S3: Lineage and cited AI (W-23)

### 7.1 Calculation runs

- **`spine.calc_run`**: `id`, `engine_module`, `function`, `engine_version` (git SHA), `params` (jsonb), `input_datapoint_ids[]`, `input_reading_query` (ledger query spec + ledger snapshot watermark), `factor_set_id` + version, `output` (jsonb), `output_hash`, `created_at`.
- Every engine output used in a report is persisted as a `calc_run`, via a decorator on engine entry points rather than hand-written calls.
- **Replay test**: re-executing any `calc_run` with its stored inputs reproduces `output_hash` exactly.

### 7.2 Report dependencies and staleness

- **`spine.report_dependency`**: `report_version_id`, `section_id`, `datapoint_id` | `calc_run_id`.
- When a datapoint is superseded or a factor set changes, dependent **draft** sections are marked **Stale**, with old → new values shown. **Signed-off versions never change**; the UI offers "Create new version".
- Per-report change log (reuse the audit trail): which inputs changed between versions, and by whom.

### 7.3 Cited narrative

- Narrative prompts for the local LLM must request citation tokens:
  - `[[dp:<uuid>]]` datapoint
  - `[[calc:<uuid>]]` calc output
  - `[[doc:<uuid>#p<page>]]` evidence page
  - `[[ref:<skill>/<file>#<anchor>]]` regulation / guidance
- **Validator** (`spine/engines/narrative_validator.py`, deterministic, runs locally) checks every generated sentence:
  1. Every number with a unit, %, £ or year must sit in a sentence with a citation whose resolved value matches **after §3.9 rounding**. Report-period years are allowlisted.
  2. Every regulatory claim (deadline, threshold, obligation) must carry a `ref:` that resolves to an existing file and anchor in the skill library.
  3. All citation tokens must resolve and belong to the same `org_id`. Cross-org citations are a hard fail.
- On failure: one regeneration with the validator errors fed back. If it fails again, mark the sentence **Unverified** (highlighted). Sign-off is blocked until the reviewer edits or explicitly accepts it, and the acceptance is audited.
- Rendered reports show the numbers and page footnotes. Tokens are converted to footnotes or to hover/click chips in the review UI; they never appear raw in client output.

### 7.4 Lineage drawer (frontend)

Click any figure or citation chip in the review screen to open a drawer:

**value** → **calculation** (engine, version, parameters) → **inputs** (tier badges) → **evidence** (open the PDF at the page, the reading row, or the register record) → **factor** (set, year, row) → **used in** (other reports and sections).

It should look like NZC AI: the same page skeleton, teal primary and existing components.

### 7.5 Evidence appendix and sign-off snapshot

- Every report export can include a **Data & Evidence appendix** (XLSX). Each row is a reported figure: section, displayed value, metric, entity, period, tier, source, evidence reference, factor set, `calc_run` ID.
- On sign-off, store the report version with a **lineage snapshot hash** (the hash of all dependency rows and their values), the signer and their qualification (e.g. ESOS Lead Assessor).

---

## 8. S4: Move every report onto the resolver

- Migrate in this order: SECR → ESOS/MESOS → GHG → CRREM → NZCBS → GRESB → TCFD → MEES/EPC. Keep each skill's golden file passing; where output legitimately changes (e.g. a conflict now resolved), update the golden file and explain why in `DECISIONS.md`.
- **Architecture test** (CI): no report or skill module queries ledger, RFI or datapoint tables directly. Reads only through `spine.resolve*`. Fail the build otherwise.
- Backfill: a one-off, re-runnable script converts existing RFI answers and extracted fields into datapoints (tier from §6; Declared where there is no document). Dry-run mode prints counts per org and metric before applying.

---

## 9. Acceptance criteria (self-verify; report each as pass/fail in `STATUS.md`)

Use a demo organisation fixture with 3 assets, 12 months of ledger data, one bill PDF with an estimated read, RFI answers with and without attachments, and the EPC register record.

1. **Change once, flagged everywhere.** Change GIA on one asset → the SECR intensity ratio, CRREM kgCO₂e/m² and NZCBS kWh/m² drafts are all marked Stale, showing old → new. After regeneration the values match the recomputed figure. The already signed-off SECR v1 is byte-identical to before.
2. **Tiers.** The estimated-read bill resolves to tier B. Accepting an expected-usage gap-fill writes tier C with a method label. An RFI answer without a document is U. The asset tier mix sums to 100%, and the SECR methodology section lists the methods with the energy share for each.
3. **Coverage → RFI.** The ESOS NoC coverage view shows resolvable/required counts with gap reasons. "Request missing data" creates RFI items; running it twice creates no duplicates.
4. **Validator.** A golden corpus of 20 sentences must all be classified correctly. It includes: a correct cited number; an uncited number; a mis-rounded number (tCO₂e at 3 dp); a citation to another org; a regulation deadline with no `ref:`; a `ref:` to a missing anchor; and a report-period year (allowed).
5. **Lineage.** From the review UI, every figure in the generated SECR report opens a drawer that reaches a reading, a document page or a register record, plus a factor set/year.
6. **Replay.** Re-executing 50 random `calc_run`s reproduces every `output_hash`.
7. **Appendix.** Every numeric value in the generated SECR .docx appears in the appendix with tier and source (automated cell-to-text check).
8. **Access.** A consultant sees only their clients' datapoints, `calc_run`s and evidence. A Business Viewer can read and export but cannot edit, downgrade or accept Unverified sentences. There are no cross-org citation leaks (API test).
9. **Locality.** A network-egress test during report generation shows no client data leaving the local stack.
10. **Build.** Migrations apply cleanly in the CI DB, engines have ≥95% branch coverage, and existing golden files and the E2E critical path are green. `PRELAUNCH.md` is updated.

---

## 10. Deliverables

- Code + migrations (reversible) in both repos on `feat/spine-s0…s4`
- `docs/spine/AUDIT.md`, `DECISIONS.md`, `METRICS.md` (the dictionary, generated from the table), `TIERS.md`, `LINEAGE.md` (token grammar + validator rules), `STATUS.md`
- Golden files: tier assignment, quality roll-ups, validator corpus, SECR appendix
- A short end-of-session update in `STATUS.md`: what shipped, acceptance N/10, unverified framework mappings, next step, open questions

---

## 11. Open questions for James (do not block S0–S2)

1. Should clients see tier letters (A/B/C/D/U) or names only? Default: names, with a letter tooltip.
2. Can Declared (U) figures appear in a signed report? Default: yes, flagged in the Data confidence panel. The signer must acknowledge the count.
3. Retention of superseded datapoints and lineage. Default: keep until the GDPR stage sets retention, aligned with ESOS record-keeping.
4. Should the Data & Evidence appendix go to clients by default or stay internal? Default: internal, optional on export.

---

## Paste this into Claude Code (fresh session at `C:\nzc-group-ai`)

You are the primary orchestrator for NZC AI (engine: FastAPI :8077 + Supabase/Postgres; frontend: React/Vite via bun; local Ollama for narrative only; Codex/Ollama sub-agents; DeepSeek only for internal non-client tasks). Scope is NZC AI only — not NZC Portal. Perse is out of scope.

Read `docs/spine/BRIEF.md` in full, then `docs/ecr/` (ECR brief + STATUS) and any Portfolio Intelligence brief in the repo.

Start with S0 only: produce `docs/spine/AUDIT.md` answering every question in §4 from the actual code, apply the §4 decision rules, record decisions in `docs/spine/DECISIONS.md`, and commit. If both an `ecr` ledger and `cr_*` tables exist with real data, stop and ask me. Otherwise continue to S1 with a written plan (files, migrations, endpoints, components, tests), then implement in small commits on `feat/spine-s1`, keeping CI green.

Non-negotiables are §3 — no LLM in any calculation path; reuse existing evidence trail, ledger, extraction, RFI portal, factor store and sign-off gate; framework field IDs only from skill reference files; client data never leaves the local stack; signed-off reports immutable.

End every session by updating `docs/spine/STATUS.md` (shipped, acceptance N/10, unverified mappings, next, questions) and `PRELAUNCH.md`.

**Continue prompt (later sessions):** Continue the Data Spine build: read `docs/spine/STATUS.md` and `DECISIONS.md`, pick up the next phase in `docs/spine/BRIEF.md`, plan, implement, keep CI green, update `STATUS.md`.
