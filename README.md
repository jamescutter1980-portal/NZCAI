# NZCAI

The AI layer behind the NZC Portal, and the deterministic engines the portal's
numbers come from.

## Layout

```
docs/competitive/   market analysis
docs/product/       feature briefs, written to be built from
docs/spine/         Data Spine brief, S0 discovery and decision log
engines/            deterministic calculation engines (no dependencies)
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
python3 -m unittest discover -s tests -t .   # 319 tests
python3 demo.py                              # worked example, end to end
```

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

## What is not built

Every engine specified in the two Scope 3 briefs now exists with tests. What
does not exist is everything around them: the database schema and migrations,
the API, the user interface, ingestion parsers for CSV, bill PDFs, PACT
payloads and the EFRAG SME template, the agent fleet, and persistence for the
audit rows the engines hand back. The Data Spine brief in `docs/spine/` is
blocked on which repository it targets; see `docs/spine/DECISIONS.md`.

## Specifications

- `docs/product/nzc-ai-scope-3-brief.md` — Layer 1: boundary, ledger, factors,
  engines, outputs.
- `docs/product/nzc-ai-scope-3-engagement-brief.md` — Layer 2: counterparty
  graph, engagement lifecycle, public-first enrichment, document intelligence,
  the chase engine, the inbound Request Inbox, the agent fleet.
- `docs/competitive/watershed-gap-analysis.md` — competitive evaluation and the
  prioritised development plan behind both.
- `docs/spine/BRIEF.md` — Data Spine: one dataset, quality tiers, cited lineage.
  Filed 10 Sep 2026. Its S0 discovery is in `docs/spine/AUDIT.md` and found that
  the brief targets a codebase this repository does not contain; two escalations
  are open in `docs/spine/DECISIONS.md` and S1 has not started.

Test names map to the acceptance criteria in the briefs, so a rule change
should break a test that names the rule.
