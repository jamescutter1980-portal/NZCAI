"""The fleet: proposals only, allowlists enforced, no agent on the path to a number."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from agents import AGENTS, Guard, ModelTurn, StubModel, ToolCall, ToolRefused, run
from agents.tools import CATALOGUE, build_tools
from api import Context
from api.seed import seed
from engines.types import EngagementState as S
from store import Store
from tests import fixtures as fx

T = ModelTurn


class Base(unittest.TestCase):
    def setUp(self):
        self.s = Store.open()
        seed(self.s, today=fx.TODAY)
        self.ctx = Context(store=self.s, org_id=fx.ORG, actor="agent", today=fx.TODAY)
        self.baseline = self._snapshot()

    def tearDown(self):
        self.s.close()

    def _snapshot(self):
        return (
            [(i, f.tco2e) for i, f, _ in self.s.list_figure_rows(fx.ORG, 2026, include_superseded=True)],
            [(e.id, e.state) for e in self.s.list_engagements(fx.ORG)],
        )

    def assertNothingChanged(self):
        self.assertEqual(self._snapshot(), self.baseline)

    def pending(self):
        return self.s.list_proposals(fx.ORG)


class Catalogue(unittest.TestCase):
    def test_every_write_tool_is_a_proposal_and_nothing_else(self):
        src = Path("agents/tools.py").read_text()
        for name in ("save_figures", "supersede_figure", "transition_engagement", "save_document",
                     "decide_proposal", "decide_conflict", "send_", "smtplib"):
            self.assertNotIn(name, src, f"agents/tools.py must not call {name}")
        writes = [t for t in CATALOGUE.values() if t.writes]
        self.assertTrue(all(t.name.startswith("propose_") or t.name == "flag" for t in writes))

    def test_no_engine_or_store_module_imports_the_agents(self):
        for p in list(Path("engines").glob("*.py")) + list(Path("store").glob("*.py")) + list(Path("api").glob("*.py")):
            self.assertNotRegex(p.read_text(), r"^\s*(from|import) agents", p)

    def test_no_agent_module_does_arithmetic_on_tonnes(self):
        for p in Path("agents").glob("*.py"):
            src = p.read_text()
            self.assertNotRegex(src, r"tco2e\s*[*/+-]=?\s*[\d(]", p)

    def test_unknown_tools_cannot_be_built(self):
        with self.assertRaises(KeyError):
            build_tools(frozenset({"save_figures"}))

    def test_every_agent_has_only_catalogue_tools_and_read_only_agents_have_no_writes(self):
        for a in AGENTS.values():
            self.assertTrue(a.tools <= CATALOGUE.keys(), a.name)
            if a.max_writes == 0:
                self.assertFalse(any(CATALOGUE[t].writes for t in a.tools), a.name)
        self.assertEqual(AGENTS["scoper"].max_writes, 0)
        self.assertEqual(AGENTS["analyst"].max_writes, 0)


class GuardRules(Base):
    def test_off_list_tools_are_refused_and_traced(self):
        g = Guard({t.name: t for t in build_tools(AGENTS["analyst"].tools)})
        with self.assertRaises(ToolRefused):
            g.check(ToolCall("propose_match", {"raw_name": "x", "candidate_id": "y", "confidence": 1, "method": "m"}))
        self.assertFalse(g.trace[-1].allowed)
        self.assertIn("allowlist", g.trace[-1].reason)

    def test_arguments_are_validated_against_the_schema(self):
        g = Guard({t.name: t for t in build_tools(frozenset({"propose_extraction"}))})
        with self.assertRaisesRegex(ToolRefused, "missing required"):
            g.check(ToolCall("propose_extraction", {"document_id": "d", "field": "f", "value": 1}))
        with self.assertRaisesRegex(ToolRefused, "unexpected argument"):
            g.check(ToolCall("propose_extraction", {"document_id": "d", "field": "f", "value": 1, "snippet": "s", "confidence": 0.9, "tco2e": 5}))
        with self.assertRaisesRegex(ToolRefused, "must be number"):
            g.check(ToolCall("propose_extraction", {"document_id": "d", "field": "f", "value": 1, "snippet": "s", "confidence": "high"}))

    def test_the_write_budget_is_a_hard_stop(self):
        g = Guard({t.name: t for t in build_tools(frozenset({"flag"}))}, max_writes=1)
        call = ToolCall("flag", {"subject": "s", "detail": "d"})
        spec = g.check(call)
        g.record(call, spec, {})
        with self.assertRaisesRegex(ToolRefused, "budget"):
            g.check(call)


class Runs(Base):
    def test_a_resolver_run_leaves_proposals_and_touches_nothing_else(self):
        model = StubModel([
            T("checking", [ToolCall("match_counterparty", {"raw_name": "BIDFOOD LIMITED"}, "c1")]),
            T("proposing", [ToolCall("propose_match", {"raw_name": "BIDFOOD LIMITED", "candidate_id": "bidfood",
                                                       "confidence": 0.86, "method": "normalised name", "evidence": "same registered number"}, "c2")]),
            T("done"),
        ])
        before = len(self.pending())
        r = run(AGENTS["resolver"], self.ctx, model, AGENTS["resolver"].prepare(self.ctx, {"raw_names": ["BIDFOOD LIMITED"]}))
        self.assertEqual(r.turns, 3)
        self.assertEqual(len(r.proposal_ids), 1)
        self.assertEqual(len(self.pending()), before + 1)
        self.assertEqual(self.pending()[-1].agent, "resolver")
        self.assertEqual(self.pending()[-1].payload["candidate_id"], "bidfood")
        self.assertEqual(r.refused, [])
        self.assertNothingChanged()
        self.assertIn("match_counterparty", model.calls[0]["tools"])
        self.assertNotIn("propose_draft", model.calls[0]["tools"])

    def test_the_prepare_step_resolves_exact_matches_without_the_model(self):
        task = json.loads(AGENTS["resolver"].prepare(self.ctx, {"raw_names": ["Bidfood Ltd", "Nobody Plc"]}))
        self.assertEqual([r["candidate"]["id"] for r in task["exact"]], ["bidfood"])
        self.assertEqual([r["raw_name"] for r in task["unmatched"]], ["Nobody Plc"])

    def test_a_model_trying_an_off_list_tool_is_refused_and_the_run_continues(self):
        model = StubModel([
            T("", [ToolCall("propose_transition", {"engagement_id": "eng_bidfood_2026", "to": "verified", "trigger": "me"}, "c1")]),
            T("ok then"),
        ])
        r = run(AGENTS["resolver"], self.ctx, model, "task")
        self.assertEqual(len(r.refused), 1)
        self.assertIn("allowlist", r.refused[0].reason)
        self.assertIs(self.s.get_engagement(fx.ORG, "eng_bidfood_2026").state, S.CONTACTED)
        self.assertEqual(r.final_text, "ok then")
        # the refusal was reported back to the model, not hidden
        self.assertIn("allowlist", model.calls[1]["messages"][-1]["content"])

    def test_an_extraction_without_a_snippet_is_refused_by_the_tool(self):
        model = StubModel([
            T("", [ToolCall("propose_extraction", {"document_id": "d", "field": "scope1_tco2e", "value": 1250.5, "snippet": "  ", "confidence": 0.9}, "c1")]),
        ])
        r = run(AGENTS["reader"], self.ctx, model, "task")
        self.assertEqual(len(r.refused), 1)
        self.assertIn("snippet", r.refused[0].reason)
        self.assertEqual(r.proposal_ids, [])

    def test_a_chaser_may_not_draft_beyond_vsme_for_a_small_supplier_or_attach_files(self):
        base = {"counterparty_id": "bakery", "rung": "day_to_day", "subject": "s", "body": "b", "outstanding": ["scope 1"]}
        model = StubModel([
            T("", [ToolCall("propose_draft", {**base, "template": "ghg_category"}, "c1")]),
            T("", [ToolCall("propose_draft", {**base, "template": "vsme", "attachments": ["x.xlsx"]}, "c2")]),
            T("", [ToolCall("propose_draft", {**base, "template": "vsme"}, "c3")]),
        ])
        r = run(AGENTS["chaser"], self.ctx, model, "task")
        self.assertEqual([t.reason for t in r.refused], ["tool failed: Pennine Bakery may only be asked in the VSME template",
                                                          "tool failed: drafts may not carry attachments"])
        self.assertEqual(len(r.proposal_ids), 1)
        self.assertEqual(self.pending()[-1].kind, "outbound_draft")

    def test_the_chaser_reads_the_contact_policy_from_the_plan_engine(self):
        model = StubModel([T("", [ToolCall("contact_policy", {"counterparty_id": "bakery"}, "c1")])])
        r = run(AGENTS["chaser"], self.ctx, model, "task")
        policy = r.trace[0].result
        self.assertTrue(policy["may_contact"])
        self.assertEqual(policy["template"], "vsme")
        self.assertIsNotNone(policy["next_step"])

    def test_the_scoper_computes_needs_in_prepare_and_has_no_write_tools(self):
        task = json.loads(AGENTS["scoper"].prepare(self.ctx, {"period": 2026}))
        self.assertTrue(task["needs"])
        self.assertEqual(task["needs"], sorted(task["needs"], key=lambda n: -n["tonnes"]))
        self.assertEqual(task["needs"][0]["ask_in"], "ghg_category_or_pact")
        bakery = next(n for n in task["needs"] if n["counterparty_id"] == "bakery")
        self.assertEqual(bakery["ask_in"], "vsme")
        model = StubModel([T("", [ToolCall("flag", {"subject": "s", "detail": "d"}, "c1")])])
        r = run(AGENTS["scoper"], self.ctx, model, "task")
        self.assertEqual(len(r.refused), 1)

    def test_the_watcher_finds_lapsed_evidence_deterministically(self):
        task = json.loads(AGENTS["watcher"].prepare(self.ctx, {}))
        self.assertTrue(task["lapsed"])
        self.assertIn("eng_dairy_co_2026", task["verified_without_valid_evidence"])
        model = StubModel([T("", [ToolCall("propose_transition", {"engagement_id": "eng_dairy_co_2026", "to": "lapsed", "trigger": "no valid evidence"}, "c1")])])
        r = run(AGENTS["watcher"], self.ctx, model, "task")
        self.assertEqual(len(r.proposal_ids), 1)
        self.assertIs(self.s.get_engagement(fx.ORG, "eng_dairy_co_2026").state, S.VERIFIED)  # proposed, not moved

    def test_the_reconciler_uses_the_engine_to_decide_what_is_a_conflict(self):
        model = StubModel([
            T("", [ToolCall("compare_values", {"subject": "s", "reported": 100, "published": 101, "reported_source": "a", "published_source": "b"}, "c1"),
                   ToolCall("compare_values", {"subject": "s", "reported": 100, "published": 150, "reported_source": "a", "published_source": "b"}, "c2")]),
        ])
        r = run(AGENTS["reconciler"], self.ctx, model, "task")
        self.assertIsNone(r.trace[0].result["conflict"])
        self.assertEqual(r.trace[1].result["conflict_class"], "reported_vs_published")

    def test_the_analyst_is_read_only_and_sees_no_raw_figures(self):
        model = StubModel([T("", [ToolCall("get_inventory", {"period": 2026}, "c1")]), T("answer")])
        r = run(AGENTS["analyst"], self.ctx, model, AGENTS["analyst"].prepare(self.ctx, {"question": "why?"}))
        self.assertNotIn("figures", r.trace[0].result)
        self.assertIn("categories", r.trace[0].result)
        self.assertFalse(any(CATALOGUE[t].writes for t in AGENTS["analyst"].tools))

    def test_the_turn_budget_stops_a_looping_model(self):
        model = StubModel([T("", [ToolCall("list_counterparties", {}, "c")]) for _ in range(20)])
        r = run(AGENTS["analyst"], self.ctx, model, "task", max_turns=3)
        self.assertEqual(r.turns, 3)
        self.assertIn("budget", r.stopped_reason)

    def test_another_organisations_context_sees_nothing(self):
        other = Context(store=self.s, org_id=fx.OTHER_ORG, actor="agent", today=fx.TODAY)
        model = StubModel([T("", [ToolCall("get_dossier", {"counterparty_id": "bidfood"}, "c1")])])
        r = run(AGENTS["analyst"], other, model, "task")
        self.assertIn("error", r.trace[0].result if r.trace[0].allowed else {"error": r.trace[0].reason})


if __name__ == "__main__":
    unittest.main()
