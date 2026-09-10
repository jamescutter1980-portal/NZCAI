# Data Spine — Decisions

Per BRIEF §0.4: decide and log, escalate only what is irreversible. Newest first.

---

## D-1 · The brief's target repository is not this one — ESCALATED

**Date:** 10 September 2026
**Status:** Needs James. Not blocking the filing of the brief, blocking S1.

The brief names `C:\nzc-group-ai` (engine repo plus frontend repo) as the workstream. This session has `jamescutter1980-portal/NZCAI`, which contains documentation and a calculation package and none of the seven things §3.2 says to extend. See `AUDIT.md`.

§4's decision rules do not cover this case. The "neither ledger exists" branch says to build against RFI and evidence tables, but those are absent too, so its premise fails. That is the difference between extending a system and building its substrate, which is a materially different amount of work and not mine to assume.

**Decided:** file the brief and the discovery, do not start S1, and do not invent a substrate.

**Needed from James, one of:**
1. A GitHub remote for `C:\nzc-group-ai` so it can be attached and audited properly, or
2. Confirmation that this repository *is* the intended home, in which case S1 becomes a greenfield build and the "reuse, don't duplicate" constraint in §3.2 falls away and should be rewritten, or
3. Confirmation that the spine belongs elsewhere entirely and this repo keeps only the docs.

---

## D-2 · Two tier taxonomies collide — ESCALATED

**Date:** 10 September 2026
**Status:** Needs James before either S2 or further Scope 3 work.

`engines/types.py::Tier` (A–E) and BRIEF §6.1 (A–D, U) both use the letters A onward and both call the field `tier`. They measure different things:

- The existing scale is the **GHG Protocol method hierarchy**: supplier-specific, hybrid, average-data, spend-based, estimated. It drives the ESRS E1-6 primary versus secondary split and the SBTi data improvement plan.
- The spine's scale is **source provenance**: measured, supplier estimate, calculated, benchmark, declared. It drives the Data confidence panel, the SECR methodology section and MESOS estimation flags.

They are orthogonal, not competing. A supplier's product footprint is method tier A whether it arrived with a document or as a bare RFI answer, and its provenance tier differs in each case. Collapsing them loses information both frameworks require.

**Recommended:** keep both as separate columns with distinct names, `method_tier` and `source_tier`, and never a bare `tier` anywhere in schema, API or UI. The badge in the review UI shows provenance, because that is what a reviewer is judging; the ESRS split reads method.

**Decided provisionally:** no renaming yet. Renaming `Tier` now would churn nine modules and 139 tests before James has confirmed the target repository under D-1, and the two scales may end up in different codebases, in which case the collision is only a naming convention to agree rather than a migration.

---

## D-3 · Spine S2 partly duplicates `engines/quality.py`

**Date:** 10 September 2026
**Status:** Decided, logged, no action until D-1 resolves.

BRIEF §6.2 specifies a `spine/engines/quality.py` doing tier roll-ups with tier mix, evidence-backed percentage and completeness. `engines/quality.py` on this branch already computes tier mix, an emissions-weighted quality score, the primary/secondary split and an improvement trajectory, with tests.

The weighting bases differ and both are correct in their own domain: kWh-weighting is right for an energy metric, tCO₂e-weighting is right for an emissions metric. A single roll-up engine should take the weighting basis as a parameter rather than hard-coding either.

**Decided:** when the spine is built, extend the existing module rather than creating a second one, and parameterise the weighting basis. Recorded so the duplication is not discovered late.

---

## D-4 · Perse is withdrawn, and three existing documents still plan for it

**Date:** 10 September 2026
**Status:** Decided and applied.

BRIEF §2 puts Perse out of scope, with "direction changed Sep 2026" and an instruction to ignore the Perse sections of the ECR brief. Five references on this branch still treat a Perse connector as planned work, four of them in the Watershed gap analysis where it sits in the Tier 2 build plan.

**Decided:** annotate rather than delete. The references are marked withdrawn with the date and reason, so the change of direction is visible to anyone reading the plan later rather than silently vanishing from it.

**Left open:** the brief bars paid data sources but does not say what replaces Perse for half-hourly interval data. Client-supplied exports and bill extraction are the obvious fallback, but that loses automated collection, which was the point. Flagged as an open question rather than answered here, since inventing a replacement is not mine to do.

---

## D-5 · Brief filed verbatim

**Date:** 10 September 2026
**Status:** Decided and applied.

The brief asks to be kept at `docs/spine/BRIEF.md`. Filed there from the source Google Doc with only Google Docs' markdown escaping removed: no content, ordering or wording changed. A dated filing note at the top points to this file and to `AUDIT.md`. Source document: `NZCAIDataSpineBrief.md`, owned by james.cutter1980@gmail.com, created 10 September 2026.
