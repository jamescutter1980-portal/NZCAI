# NZCAI

The AI layer behind the NZC Portal, and the deterministic engines the portal's
numbers come from.

## Layout

```
docs/competitive/   market analysis
docs/product/       feature briefs, written to be built from
docs/spine/         Data Spine brief, S0 discovery and decision log
engines/            deterministic calculation engines (no dependencies)
store/              SQLite repository, Postgres migrations with row-level security
ingest/             parsers: ledger and activity CSV, PACT, VSME, utility bills
api/                pure request handlers, router, stdlib HTTP adapter, demo seed
agents/             the agent fleet: guarded tools, proposals only, stub model
web/                React front end (Vite), served by the adapter when built
tests/              unit tests derived from the briefs' acceptance criteria
demo.py             end-to-end walkthrough on a worked example
```

## The engines

`engines/` holds every rule that decides a number, with no third-party
dependencies and no model call anywhere on the path to a figure. Agents
resolve, enrich, draft, extract, rank and flag; a person confirms; the
arithmetic happens here.

**Calculation, Layer 1**

| Module | What it does |
|---|---|
| `factors` | The emission factor library, versioned, loaded from CSV, refusing placeholders by default |
| `activity` | Quantity times factor, tier C, with full lineage |
| `eeio` | Spend times sector factor, deflated to the factor's price year, VAT stripped, tier D |
| `spend_map` | Ledger line to sector by rule: exclusions first, GL codes before keywords, never guessed |
| `fuel_sold` | Category 11 for fuel retailers, well-to-tank in category 1 where bought for resale, resold electricity as a disclosure |
| `partner` | Supplier-reported allocations at tier B and product footprints at tier A |
| `boundary` | Which scope or Scope 3 category an outlet's activity lands in, from its operator role |
| `leased` | Categories 13, 8 and 14 from outlet energy, placed by the boundary rules with shared-site allocation |
| `franchise` | Per-outlet and per-brand packs for reporting upward to a franchisor |
| `screen` | The annual fifteen-category relevance screen, every category with a reason |
| `quality` | Method tiers, the ESRS E1-6 primary/secondary split, trajectory |
| `coverage` | SBTi near-term, exclusion, category 11 and alignment tests |
| `hotspots` | Ranking by any dimension, and what-if levers that never touch the record |
| `consolidate` | Entity roll-up for a parent's statement, by category, entity and tag |

**Engagement, Layer 2**

| Module | What it does |
|---|---|
| `resolve` | Ledger names to legal entities and their group root, conclusively or not at all |
| `scope` | What is still needed from a counterparty after what we already hold |
| `lifecycle` | The engagement state machine |
| `score` | Who to chase, in what order, and who not to chase at all |
| `plan` | Cadence, the escalation ladder, template choice, fatigue control |
| `outcome` | Observed response rates by how we asked, with a sample guard, never a model |
| `validity` | Document expiry and the lapse detection that re-opens a chase |
| `conflict` | Disagreements between what a counterparty tells us and publishes, including persistent variance over time |
| `disclosure` | Whether a document may be shown to a given organisation |

`types` holds the shared enums and dataclasses, mirrored in the database schema.

Five design rules run through all of it. A figure cannot exist without a
factor source and version. A factor is applied only in its own unit or one
that converts exactly. A placeholder factor is refused unless the caller opts
in. A state cannot change without an audit row, returned alongside it. A
document's confidentiality basis is enforced in one place and fails closed on
anything unattributed.

## Running it

Requires Python 3.11 or later. Nothing to install.

```bash
python3 -m unittest discover -s tests -t .   # 423 tests, no network
python3 demo.py                              # worked example, end to end
```

To run the portal locally, build the front end once (Node 22) and start the
adapter with the demo data:

```bash
cd web && npm install && npm run build && cd ..
python3 -m api.server --seed --static --port 8765
# open http://127.0.0.1:8765/
```

For front-end development, `npm run dev` in `web/` proxies `/api` to the
adapter on port 8765. The Playwright smoke test is `node web/smoke.mjs <port>`
against a seeded, static-serving adapter.

The demo runs a motorway services operator: franchised catering brands, a
supermarket concession, hotels, a forecourt and a charging hub. It starts from
activity data and cited factor rows, then prints the inventory, the SBTi gates
with the reasons a submission would fail, the data quality trajectory, the
ranked engagement plan, the evidence needing replacement, the conflicts raised
for a human to settle, and the same evidence set exported for two different
clients of the same consultancy.

## Factor data

`engines/data/desnz_2025.csv` holds 15 verified rows from the UK Government
2025 conversion factors: grid electricity and its transmission losses, natural
gas, petrol, diesel, LPG, average car, national rail, short and long haul
flying, and five refrigerants.

`engines/data/illustrative_factors.csv` holds 15 placeholders with deliberately
round values for spend-based sectors, food, packaging, waste routes, freight
and well-to-tank. Every row is marked `illustrative` and the library refuses
to serve one unless opened with `allow_illustrative=True`. Tests and the demo
opt in. **Nothing client-facing may.** Before production use, load the real
DESNZ waste, WTT and freight rows and an Open CEDA or equivalent spend table.

## The layers around the engines

**Store.** `store/repository.py` persists what the engines produce, scoped by
organisation on every query. Figures and audit rows are append-only at the
database level: a correction inserts a replacement and marks the old row
superseded, and the chain is what the lineage drawer shows. A lifecycle
transition writes its state change and its audit row in one transaction or
not at all. `store/migrations/` is the same model for Postgres with row-level
security keyed on organisation membership; `tests/test_store.py` checks the
migration's CHECK lists against the enums in `engines/types.py`.

**Ingest.** Five parsers turn external shapes into engine inputs and nothing
more. Each returns the rows that parsed and the rows that did not, by
position, so a bad line is reported rather than lost. PACT accepts 2.x and
3.x field names; VSME reads the EFRAG xlsx template by label and xBRL-JSON by
concept; bill reading takes an injected PDF-to-text function.

**API.** `api/handlers.py` is the API: functions taking a context and
returning a status and payload, tested directly. `api/server.py` is a
standard-library adapter for local runs and the front end; the organisation
comes from a header there and from the session in production. Ingestion
routes persist figures and documents only when the parse is clean, or when
asked to accept a partial batch.

**Agents.** Eight named agents from the Layer 2 brief, each with an explicit
allowlist and write budget. Every write tool is a proposal into the review
queue: nothing in `agents/` can write a figure, move an engagement or send a
message, and `tests/test_agents.py` greps the package to hold that. Each
agent's `prepare` step does the deterministic work with the engines before a
model is asked anything; the model is behind a protocol with a scripted stub
for tests and thin Anthropic and Ollama adapters.

**Web.** A Vite and React front end with the plan, counterparties, dossier,
inventory with lineage drawer, target readiness with a boundary selector,
and the review queue. `web/smoke.mjs` drives the built app through Playwright
against the seeded adapter.

## What is not built

Sending. Drafts land in the review queue and stop there: there is no mailbox,
no tokenised confirmation page and no SFTP or PACT endpoint, because those
are outward-facing and the brief's own questions on auto-send policy and
the monitored mailbox are still open. Authentication and the production
host are the adapter's job and are not in this repository. Annual spend per
counterparty is passed to the plan by the caller rather than held in the
store. The front end reads one fixed reporting period.

## Specifications

- `docs/product/nzc-ai-scope-3-brief.md` — Layer 1: boundary, ledger, factors,
  engines, outputs.
- `docs/product/nzc-ai-scope-3-engagement-brief.md` — Layer 2: counterparty
  graph, engagement lifecycle, public-first enrichment, document intelligence,
  the chase engine, the inbound Request Inbox, the agent fleet.
- `docs/competitive/watershed-gap-analysis.md` — competitive evaluation and the
  prioritised development plan behind both.
- `docs/spine/BRIEF.md` — Data Spine: one dataset, quality tiers, cited lineage.
  Filed 10 Sep 2026. Its S0 discovery is in `docs/spine/AUDIT.md`. D-1 in
  `docs/spine/DECISIONS.md` is resolved: this repository is the home. D-2, the
  tier naming collision, is still open.

Test names map to the acceptance criteria in the briefs, so a rule change
should break a test that names the rule.
