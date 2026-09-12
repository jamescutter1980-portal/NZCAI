# PRELAUNCH

Things that must be settled before NZC AI goes near a client. Opened by Task 0
of the Site Intelligence brief, which asks for a migration ticket to be recorded
here. Fuller status and open decisions are in
[`docs/site-intel/PLAN.md`](docs/site-intel/PLAN.md).

---

## TICKET-01 — EPC register endpoint migration

**Raised by:** Task 0 · **Status:** mitigated, watch · **Owner:** unassigned

EPC open data has moved to `get-energy-performance-data.communities.gov.uk`. The
legacy host, `epc.opendatacommunities.org`, still answers and has **no published
retirement date**.

The brief asks not to break the current integration. There was no existing
integration to break — no register retrieval module existed — so the new client
targets the new host by default and the legacy host is reachable by setting
`EPC_API_BASE`. Both speak the same API, and the host that answered is reported
on every lookup, so a silent migration is visible.

**Before launch:**

- [ ] Confirm which host the account's credentials are registered against.
      Credentials issued on the legacy site may or may not carry over.
- [ ] Run `npm run epc:verify -- <postcode>` against both hosts and compare.
- [ ] Watch for a retirement announcement; if the legacy host is retired,
      nothing needs changing, but confirm.

**Unverified:** this build had no network access to either host, so no live call
has been made. The request shape follows the documented API but has not been
exercised.

---

## TICKET-02 — UPRN provenance is not uniform

**Raised by:** Task 0 · **Status:** handled in code · **Owner:** n/a

The register carries a `uprn` field but `uprn-source` distinguishes a UPRN the
register matched algorithmically ("Address Matched") from one an energy assessor
typed into assessment software ("Energy Assessor"). They are not the same grade
of identifier.

Handled: an address-matched UPRN is treated as register-grade (T1), an
assessor-entered one as inferred (T3), and the source is reported on every
certificate. Recorded here because it is easy to undo by accident — anything
that collapses the two back into "has a UPRN" reintroduces the problem.

---

## TICKET-03 — Attribution strings unverified

**Status:** blocking for client use

All attribution strings in `src/lib/site-intel/sources.yaml` are transcribed
from memory of the licence pages, because this build could not reach them. Every
entry is `attribution_verified: false`, `npm run site:verify` lists them, and the
API returns the unverified set with every profile.

Attribution is a licence condition, not a nicety. Check each against its
`licence_url` before anything reaches a client.

---

## TICKET-04 — Constraint wording needs sign-off

**Status:** blocking for client use

All 21 rules in `src/lib/site-intel/constraint_rules.yaml` are
`approved: false`. James signs off the wording; the brief is explicit that code
returns states and rule keys only.

---

## TICKET-05 — CCOD and OCOD licence terms unread

**Status:** blocking for commercial use

HM Land Registry's corporate ownership datasets are **not plain OGL**. Both
require registration and acceptance of HMLR's own licence, which carries
conditions on redistribution. Those terms have not been read.

---

## TICKET-06 — Dataset slugs and column positions unverified

**Status:** first-run check

Nothing in this build has been exercised against a live source — the network
blocked every one. Before trusting any ingested data:

- [ ] `npm run grid:verify` — DNO dataset slugs (only Northern Powergrid's
      heatmap is confirmed)
- [ ] `npm run site:verify` — planning.data slugs, reference data, attributions
- [ ] `npm run site:load-voa -- list <file>` — VOA column positions; the loader
      prints the first parsed record for exactly this check
- [ ] EA flood service URL in `src/lib/site-intel/flood.ts`

---

## TICKET-07 — Fixture sites not chosen

**Status:** blocks meaningful contract tests

The brief (§9) asks for eight confirmed fixture sites covering a listed building
in a conservation area, Flood Zone 3, an exact UPRN match, the Google candidate
path, a multi-building title, a Welsh address, three DNO areas, and an LPA with
incomplete coverage. None have been chosen. Until they are, the recorded
fixtures are constructed rather than real, and the nightly contract tests the
brief asks for cannot be written.

---

## TICKET-08 — Stack decision outstanding

**Status:** architectural

The brief specifies a Python/FastAPI engine. This is Next.js and TypeScript, as
instructed in the build session. The data model, registries, normalisation and
screening logic port cheaply; the API routes and UI do not. See PLAN.md §3.1.

---

## TICKET-09 — MEES wording and thresholds need sign-off

**Raised by:** S-05 · **Status:** blocking for client use · **Owner:** James

All 16 entries in `src/lib/site-intel/mees_rules.yaml` are `approved: false`.
This is the same rule as TICKET-04 with more at stake: constraint wording
describes a planning position, MEES wording describes a **legal duty**, and part
of what it describes is not yet law.

Three things in that file must be read against the source before anyone sets
`approved: true`:

1. **The 2031 EPC B target is proposed, not enacted.** It applies to buildings
   over 1,000 m² and still requires secondary legislation. The wording says so
   everywhere it appears; confirm that is still true at sign-off, and re-check
   whenever the legislation moves.
2. **The 2027 EPC C milestone is recorded as dropped** (18 June 2026). It is
   held in the file deliberately, so the system can state the negative — plans
   and third-party advice written before that date may still assume the duty.
3. **The band boundaries** (A+ ≤25 through G ≥176) are transcribed, not derived.
   They decide every screening result. Check them against the published
   non-domestic table.

Source of record: SI 2015/962 as amended, and the DESNZ Interim Response to the
2019/2021 non-domestic PRS consultations published 18 June 2026, as recorded in
the Focus Green `mees-advisory` skill.

`npm run site:verify` prints the count outstanding and the policy position the
file currently encodes.

---

## TICKET-10 — The PRS Exemptions Register is not held

**Raised by:** S-05 · **Status:** known gap, stated in every result

A building below EPC E with a registered exemption is **lawfully let**. The PRS
Exemptions Register is not a dataset this system holds, so a below-minimum
screening result is a prompt to check, never a finding of breach. Every result
says so, and no state in `mees_rules.yaml` uses the words "compliant" or
"non-compliant" — a test enforces that.

Decide before client use whether to ingest the register (if it is obtainable in
bulk) or to keep the caveat as the answer. If a MEES prospect list (S-08) is
ever built on top of this, the distinction stops being cosmetic: a list of
"non-compliant buildings" that is really a list of "buildings whose exemption
status is unknown" would be wrong in a way clients act on.
