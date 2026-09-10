# NZCAI

The AI layer behind the NZC Portal, and the deterministic engines the portal's
numbers come from.

## Layout

```
docs/competitive/   market analysis
docs/product/       feature briefs, written to be built from
engines/            deterministic calculation engines (no dependencies)
tests/              unit tests derived from the briefs' acceptance criteria
demo.py             end-to-end walkthrough on a worked example
```

## The engines

`engines/` holds every rule that decides a number, with no third-party
dependencies and no model call anywhere on the path to a figure. Agents
resolve, enrich, draft, extract, rank and flag; a person confirms; the
arithmetic happens here.

| Module | What it decides |
|---|---|
| `types` | Shared enums and dataclasses, mirrored in the database schema |
| `boundary` | Which scope or Scope 3 category an outlet's activity lands in |
| `quality` | Method tiers, the ESRS E1-6 primary/secondary split, trajectory |
| `coverage` | SBTi near-term, exclusion, category 11 and alignment tests |
| `lifecycle` | The engagement state machine |
| `score` | Who to chase, in what order, and who not to chase at all |
| `plan` | Cadence, the escalation ladder, template choice, fatigue control |
| `validity` | Document expiry and the lapse detection that re-opens a chase |
| `conflict` | Disagreements between what a counterparty tells us and publishes |

Two design rules run through all of it. A figure cannot exist without a factor
source and version, enforced in the constructor. A state cannot change without
an audit row, enforced by returning both together.

## Running it

Requires Python 3.11 or later. Nothing to install.

```bash
python3 -m unittest discover -s tests -t .   # 139 tests
python3 demo.py                              # worked example, end to end
```

The demo runs a motorway services operator: franchised catering brands, a
supermarket concession, hotels, a forecourt and a charging hub. It prints the
inventory, the SBTi gates with the reasons a submission would fail, the data
quality trajectory, the ranked engagement plan, the evidence needing
replacement and the conflicts raised for a human to settle.

## Specifications

- `docs/product/nzc-ai-scope-3-brief.md` — Layer 1: boundary, ledger, factors,
  engines, outputs.
- `docs/product/nzc-ai-scope-3-engagement-brief.md` — Layer 2: counterparty
  graph, engagement lifecycle, public-first enrichment, document intelligence,
  the chase engine, the inbound Request Inbox, the agent fleet.
- `docs/competitive/watershed-gap-analysis.md` — competitive evaluation and the
  prioritised development plan behind both.

Test names map to the acceptance criteria in the briefs, so a rule change
should break a test that names the rule.
