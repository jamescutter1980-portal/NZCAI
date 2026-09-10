# Data Spine — S0 Discovery

**Brief:** NZCAI-FB-2026-09-10-SPINE §4
**Run:** 10 September 2026
**Repository audited:** `jamescutter1980-portal/NZCAI` on branch `claude/watershed-competitive-analysis-ndancb`
**Method:** full file listing plus grep across every tracked `.py`, `.sql`, `.ts` and `.tsx` file.

---

## Headline

**The brief targets a codebase this repository does not contain.** §3.2 says "reuse, don't duplicate" and lists seven things to extend. None of the seven exists here. The repository holds documentation and a dependency-free calculation package, with no database, no web framework, no persistence layer and no model calls of any kind.

The §4 decision rules assume one of three worlds: one ledger, neither ledger, or both. The actual answer is a fourth the rules do not cover, because the "neither" branch still assumes RFI and evidence tables to build against, and those are absent too. See `DECISIONS.md` D-1.

---

## §4 questions, answered against what is actually here

| # | Question | Finding |
|---|---|---|
| 1 | Which ledger exists: `ecr` schema, `cr_*` tables, both or neither? Row counts? | **Neither.** Zero SQL files, zero migrations, no Supabase or Postgres client, no ORM. Row counts not applicable: there is no database. |
| 2 | Evidence / audit-trail tables, columns, write attribution | **No tables.** The only audit construct is `engines/lifecycle.py::AuditRow`, a frozen dataclass carrying `engagement_id`, `from_state`, `to_state`, `actor`, `trigger`, `at`, `evidence_id`. `transition()` returns it alongside the new state so a caller cannot advance state without also holding the audit row, but nothing persists it. There is no middleware. |
| 3 | RFI portal: where are answers stored? Do they carry document and responder? | **Not present.** No RFI code, no storage, no responder model. |
| 4 | PDF extraction: output shape, page number, bounding box | **Not present.** `engines/types.py::Document` models a document's identity, type, validity window and confidentiality basis, but carries no extraction payload and no page or bounding-box locator. No extraction code exists. |
| 5 | Factor store: how a factor set is versioned and referenced | **No store.** Every `Figure` carries `factor_source` and `factor_version` as free text, and the constructor rejects a figure missing either. That enforces the discipline but is not a versioned factor table, and nothing validates the strings against a catalogue. |
| 6 | For each report skill, where does it read its inputs today? | **Not in this repository.** SECR, ESOS/MESOS, GRESB, CRREM, NZCBS, TCFD, GHG, MEES and EPC exist as Claude skill packages in the operator's skill library, not as repository code. They read from uploaded and pasted client data at run time. There is nothing here to migrate onto a resolver. |
| 7 | Sign-off gate: how it works, what it stores | **Not present as code.** The concept appears in the briefs. No implementation. |
| 8 | Narrative generation: prompt location, model, post-processing | **Not present.** No prompt files, no Ollama client, no model call anywhere. The calculation package contains no LLM call by design, which satisfies §3.1 trivially but means there is no narrative to validate. |

---

## What this repository does contain

| Path | Contents |
|---|---|
| `docs/competitive/` | Watershed gap analysis, 9 Sep 2026 |
| `docs/product/` | Scope 3 Layer 1 (ledger and boundary) and Layer 2 (value chain engagement) briefs |
| `docs/spine/` | This brief and its discovery output |
| `engines/` | Nine dependency-free modules: `types`, `boundary`, `quality`, `coverage`, `lifecycle`, `score`, `plan`, `validity`, `conflict` |
| `tests/` | 139 unit tests derived from the acceptance criteria in the Scope 3 briefs |
| `demo.py` | End-to-end walkthrough on a motorway services fixture |

Grep counts for the substrate the brief expects to extend:

```
ecr           0 code files      supabase      0 code files
cr_*          0 code files      fastapi       0 code files
rfi           0 code files      ollama        0 code files
audit_trail   0 code files      sign_off      0 code files
```

The 13 hits for "evidence" and 6 for "factor" are field names on frozen dataclasses (`evidence_id`, `factor_source`, `factor_version`), not storage.

---

## Overlap with work already on this branch

Two spine phases are partly built here already, under different assumptions. This is not a blocker but it is duplicated effort waiting to happen, and it is recorded as D-2 and D-3 in `DECISIONS.md`.

**S2 quality roll-ups.** `engines/quality.py` already computes tier mixes, an emissions-weighted data-quality score, a primary versus secondary split and an improvement trajectory. The spine's §6.2 specifies the same shape of function with a different weighting basis and a different hierarchy.

**Tier taxonomy.** Both use the letters A to D and both call the field "tier", but they measure different things and are not interchangeable.

| | Existing `engines/types.py::Tier` | Spine §6.1 |
|---|---|---|
| Question answered | Which GHG Protocol method produced this figure? | What evidence stands behind this figure? |
| A | Supplier-specific | Measured |
| B | Hybrid, supplier-reported and allocated | Supplier estimate |
| C | Average-data, physical activity | Calculated |
| D | Spend-based EEIO | Benchmark |
| E / U | E, estimated or extrapolated | U, Declared |
| Drives | ESRS E1-6 primary/secondary split, SBTi data improvement plan | Data confidence panel, SECR methodology, MESOS estimation flags |
| Weighting | Emissions-weighted (tCO₂e) | kWh-weighted for additive metrics |

A supplier's product carbon footprint is method tier A. Its provenance tier is A if a document backs it and U if it arrived as an unevidenced RFI answer. One value cannot carry both meanings.

---

## Open framework mappings

None verified, because §5.1's `spine.framework_field` table does not exist yet and §3.3 forbids populating field IDs from memory. Every mapping will start unverified and be resolved against the skill reference files at S1.

---

## Recommended next step

Attach the real target. If `C:\nzc-group-ai` has a GitHub remote, add it to the session and re-run this discovery against it; §4's questions are answerable in an hour there and the answers change S1 materially. Until then, S1 cannot start against the substrate the brief assumes.
