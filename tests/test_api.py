"""The API: handlers against a seeded store, and one round trip through HTTP."""

from __future__ import annotations

import json
import threading
import unittest
from datetime import date
from http.client import HTTPConnection
from pathlib import Path

from api import Context, handle, match
from api.seed import seed
from api.server import make_server
from engines.types import EngagementState as S
from store import Store
from tests import fixtures as fx

FIX = Path("tests/fixtures_files")


class Base(unittest.TestCase):
    def setUp(self):
        self.s = Store.open()
        seed(self.s, today=fx.TODAY)
        self.ctx = Context(store=self.s, org_id=fx.ORG, actor="james", today=fx.TODAY)
        self.other = Context(store=self.s, org_id=fx.OTHER_ORG, actor="someone", today=fx.TODAY)

    def tearDown(self):
        self.s.close()

    def call(self, method, path, body=None, ctx=None, **query):
        found = match(method, path)
        self.assertIsNotNone(found, f"no route for {method} {path}")
        name, params = found
        params.update({k: str(v) for k, v in query.items()})
        status, payload = handle(name, ctx or self.ctx, params, body or {})
        json.dumps(payload)  # must be serialisable
        return status, payload


class Routing(unittest.TestCase):
    def test_paths_capture_parameters(self):
        self.assertEqual(match("GET", "/api/counterparties/bidfood"), ("counterparty_dossier", {"id": "bidfood"}))
        self.assertEqual(match("POST", "/api/engagements/e1/transition"), ("transition_engagement", {"id": "e1"}))

    def test_wrong_method_and_unknown_path_differ(self):
        self.assertEqual(match("DELETE", "/api/counterparties"), ("method_not_allowed", {}))
        self.assertIsNone(match("GET", "/api/nothing"))
        self.assertEqual(handle("method_not_allowed", None, {}, {})[0], 405)
        self.assertEqual(handle("nope", None, {}, {})[0], 404)


class Inventory(Base):
    def test_the_inventory_carries_figures_with_ids_and_quality_rows(self):
        status, p = self.call("GET", "/api/inventory", period=2026)
        self.assertEqual(status, 200)
        self.assertAlmostEqual(p["total_tco2e"], sum(f.tco2e for f in fx.FIGURES))
        self.assertTrue(all("id" in f and "tier" in f for f in p["figures"]))
        self.assertEqual({c["category"] for c in p["categories"]} <= {c.value for c in __import__("engines.types", fromlist=["Category"]).Category}, True)
        self.assertIn("achievable_primary_share", p["trajectory"])

    def test_another_organisation_sees_an_empty_inventory(self):
        status, p = self.call("GET", "/api/inventory", ctx=self.other, period=2026)
        self.assertEqual(p["figures"], [])
        self.assertEqual(p["total_tco2e"], 0)

    def test_a_supersession_leaves_a_lineage_chain(self):
        _, inv = self.call("GET", "/api/inventory", period=2026)
        first = inv["figures"][0]
        status, p = self.call("POST", f"/api/figures/{first['id']}/supersede", body={
            "category": first["category"], "tco2e": first["tco2e"] * 1.1, "tier": first["tier"],
            "factor_source": "review", "factor_version": "1", "counterparty_id": first["counterparty_id"]})
        self.assertEqual(status, 201)
        status, chain = self.call("GET", f"/api/figures/{p['id']}/lineage")
        self.assertEqual([c["id"] for c in chain["chain"]], [first["id"], p["id"]])
        self.assertEqual(chain["chain"][0]["status"], "superseded")

    def test_a_figure_without_a_factor_source_is_refused(self):
        status, p = self.call("POST", "/api/figures/1/supersede", body={"category": "1", "tco2e": 1, "tier": "D", "factor_source": "", "factor_version": ""})
        self.assertEqual(status, 400)
        self.assertIn("factor source", p["error"])


class Coverage(Base):
    def test_coverage_reports_the_sbti_gates(self):
        status, p = self.call("GET", "/api/coverage", period=2026, scope1=30_000, scope2=12_000, sells_fossil_fuel="true")
        self.assertEqual(status, 200)
        r = p["result"]
        self.assertTrue(r["scope3_target_required"])
        self.assertTrue(r["category_11_mandatory"])
        self.assertIn(r["rag"], ("green", "amber", "red"))
        self.assertIn("submission_ready", r)

    def test_a_narrower_covered_set_changes_the_answer(self):
        _, wide = self.call("GET", "/api/coverage", period=2026, scope1=1, scope2=1)
        _, narrow = self.call("GET", "/api/coverage", period=2026, scope1=1, scope2=1, covered="6,7")
        self.assertGreater(wide["result"]["near_term_coverage"], narrow["result"]["near_term_coverage"])
        self.assertEqual(narrow["covered"], ["6", "7"])

    def test_the_screen_runs_from_query_flags(self):
        status, p = self.call("GET", "/api/screen", employee_count=5000, sells_fossil_fuel="true", is_franchisor="true")
        self.assertEqual(status, 200)
        by = {c["category"]: c for c in p["categories"]}
        self.assertTrue(by["11"]["relevant"] and by["11"]["mandatory_target"])
        self.assertTrue(by["14"]["relevant"])


class Counterparties(Base):
    def test_the_list_is_ranked_by_tonnes_and_carries_the_engagement(self):
        status, p = self.call("GET", "/api/counterparties", period=2026)
        rows = p["counterparties"]
        self.assertEqual([r["tco2e"] for r in rows], sorted((r["tco2e"] for r in rows), reverse=True))
        bidfood = next(r for r in rows if r["id"] == "bidfood")
        self.assertEqual(bidfood["engagement"]["state"], "contacted")
        self.assertTrue(bidfood["open"])

    def test_the_dossier_gathers_everything_in_one_call(self):
        status, p = self.call("GET", "/api/counterparties/starbucks", period=2026, spend=2_000_000)
        self.assertEqual(status, 200)
        self.assertTrue(p["counterparty"]["spans_value_chain"])
        self.assertIn(p["score"]["route"], ("engage_direct", "accept_published", "negotiate_at_renewal", "use_secondary"))
        self.assertEqual(p["template"], "ghg_category")
        self.assertEqual(len(p["engagements"]), 1)
        self.assertGreaterEqual(len(p["audit"][p["engagements"][0]["id"]]), 5)

    def test_creation_validates_roles_and_is_scoped(self):
        status, p = self.call("POST", "/api/counterparties", body={"id": "new", "name": "New Co", "roles": ["landlord"]})
        self.assertEqual(status, 201)
        self.assertTrue(p["is_dominant"])
        status, p = self.call("POST", "/api/counterparties", body={"id": "bad", "name": "Bad", "roles": ["overlord"]})
        self.assertEqual(status, 400)
        self.assertEqual(self.call("GET", "/api/counterparties/new", ctx=self.other)[0], 404)


class Plan(Base):
    def test_the_plan_ranks_routes_and_tiers_everyone(self):
        status, p = self.call("GET", "/api/plan", body={"spend": fx.ANNUAL_SPEND}, period=2026)
        self.assertEqual(status, 200)
        rows = p["rows"]
        self.assertEqual(len(rows), len(fx.COUNTERPARTIES))
        self.assertEqual([r["score"]["score"] for r in rows], sorted((r["score"]["score"] for r in rows), reverse=True))
        self.assertTrue(all(r["tier"] in ("T1", "T2", "T3", "T4") for r in rows))
        by = {r["counterparty"]["id"]: r for r in rows}
        self.assertEqual(by["applegreen"]["score"]["route"], "accept_published")
        self.assertEqual(by["bakery"]["template"], "vsme")
        self.assertIsNotNone(by["bidfood"]["next_step"])
        self.assertIsNone(by["dairy_co"]["next_step"])  # verified: nothing left to chase
        self.assertAlmostEqual(p["total_uplift_tco2e"], sum(fx.uplift_by_counterparty().values()))


class Engagements(Base):
    def test_a_transition_returns_state_and_audit_row_and_is_refused_when_illegal(self):
        status, p = self.call("POST", "/api/engagements/eng_bidfood_2026/transition", body={"to": "engaged", "trigger": "email"})
        self.assertEqual(status, 200)
        self.assertEqual(p["engagement"]["state"], "engaged")
        self.assertEqual(p["audit_row"]["actor"], "james")
        status, p = self.call("POST", "/api/engagements/eng_bidfood_2026/transition", body={"to": "identified"})
        self.assertEqual(status, 409)
        status, p = self.call("POST", "/api/engagements/eng_bidfood_2026/transition", body={"to": "declined"})
        self.assertEqual(status, 409)  # no reason given
        status, p = self.call("POST", "/api/engagements/eng_bidfood_2026/transition", body={"to": "declined", "decline_reason": "vsme_cap"})
        self.assertEqual(status, 200)

    def test_get_carries_the_schedule_and_next_step(self):
        status, p = self.call("GET", "/api/engagements/eng_bidfood_2026")
        self.assertEqual(len(p["schedule"]), 6)
        self.assertIsNotNone(p["next_step"])
        self.assertEqual(len(p["audit"]), 4)

    def test_creation_needs_a_counterparty_in_this_organisation(self):
        status, p = self.call("POST", "/api/engagements", body={"id": "x", "counterparty_id": "nobody", "period": 2026})
        self.assertEqual(status, 404)
        status, p = self.call("POST", "/api/engagements", body={"id": "x", "counterparty_id": "bidfood", "period": 2027, "deadline": "2027-06-30"})
        self.assertEqual(status, 201)
        self.assertEqual(p["state"], "unidentified")
        self.assertIn("x", {e["id"] for e in self.call("GET", "/api/engagements", state="unidentified")[1]["engagements"]})
        self.assertEqual([e["id"] for e in self.call("GET", "/api/engagements", period=2027)[1]["engagements"]], ["x"])

    def test_bad_input_is_400_not_500(self):
        self.assertEqual(self.call("POST", "/api/engagements/eng_bidfood_2026/transition", body={})[0], 400)
        self.assertEqual(self.call("POST", "/api/engagements/eng_bidfood_2026/transition", body={"to": "flying"})[0], 400)
        self.assertEqual(self.call("GET", "/api/engagements", state="flying")[0], 400)


class Documents(Base):
    def test_the_owner_sees_its_documents_and_another_client_sees_only_what_it_may(self):
        mine = {d["id"] for d in self.call("GET", "/api/documents")[1]["documents"]}
        self.assertIn(fx.PCF_UNDER_NDA.id, mine)
        theirs = {d["id"] for d in self.call("GET", "/api/documents", ctx=self.other)[1]["documents"]}
        self.assertEqual(theirs, {fx.REPORT_CURRENT.id, fx.REPORT_STALE.id, fx.VSME_CONSENTED.id})

    def test_a_created_document_is_owned_by_the_caller(self):
        status, p = self.call("POST", "/api/documents", body={"id": "d1", "counterparty_id": "bidfood", "doc_type": "invoice", "issue_date": "2026-03-01"})
        self.assertEqual(status, 201)
        self.assertEqual(p["owner_org_id"], fx.ORG)
        self.assertNotIn("d1", {d["id"] for d in self.call("GET", "/api/documents", ctx=self.other)[1]["documents"]})


class Review(Base):
    def test_the_queue_holds_proposals_and_conflicts_until_decided(self):
        _, q = self.call("GET", "/api/review")
        self.assertEqual(len(q["proposals"]), 2)
        self.assertEqual(len(q["conflicts"]), 1)
        pid, cid = q["proposals"][0]["id"], q["conflicts"][0]["id"]
        status, p = self.call("POST", f"/api/review/proposals/{pid}", body={"accept": False})
        self.assertEqual(p["status"], "rejected")
        self.assertEqual(p["decided_by"], "james")
        status, p = self.call("POST", f"/api/review/conflicts/{cid}", body={"decision": "use published"})
        self.assertEqual(status, 200)
        _, q = self.call("GET", "/api/review")
        self.assertEqual((len(q["proposals"]), len(q["conflicts"])), (1, 0))

    def test_another_organisation_cannot_decide_our_queue(self):
        _, q = self.call("GET", "/api/review")
        self.assertEqual(self.call("POST", f"/api/review/proposals/{q['proposals'][0]['id']}", body={"accept": True}, ctx=self.other)[0], 404)
        self.assertEqual(self.call("GET", "/api/review", ctx=self.other)[1]["proposals"], [])


class Ingest(Base):
    def test_activity_csv_is_parsed_calculated_and_written_only_when_clean(self):
        text = (FIX / "activity.csv").read_text()
        status, p = self.call("POST", "/api/ingest/activity", body={"text": text, "period": 2026})
        self.assertEqual(status, 207)
        self.assertEqual(len(p["figures"]), 3)
        self.assertEqual(p["written"], {})
        status, p = self.call("POST", "/api/ingest/activity", body={"text": text, "period": 2026, "partial": True})
        self.assertEqual(len(p["written"]["figure_ids"]), 3)

    def test_pact_writes_the_document_and_a_tier_a_figure(self):
        raw = (FIX / "pact_v3.json").read_text()
        status, p = self.call("POST", "/api/ingest/pact", body={"text": raw, "counterparty_id": "bidfood", "quantity": 10000, "unit": "kg", "period": 2026})
        self.assertEqual(status, 200)
        self.assertEqual(p["figures"][0]["tier"], "A")
        self.assertEqual(len(p["written"]["document_ids"]), 1)
        docs = {d["id"] for d in self.call("GET", "/api/documents", counterparty_id="bidfood")[1]["documents"]}
        self.assertIn(p["written"]["document_ids"][0], docs)

    def test_vsme_allocates_when_told_the_share(self):
        import base64
        raw = base64.b64encode((FIX / "vsme.xlsx").read_bytes()).decode()
        status, p = self.call("POST", "/api/ingest/vsme", body={"bytes_base64": raw, "counterparty_id": "bakery", "period": 2025, "our_share": 0.1})
        self.assertEqual(status, 200)
        self.assertEqual(p["returns"][0]["employees"], 40)
        self.assertEqual(p["figures"][0]["tier"], "B")
        self.assertIn("figure_ids", p["written"])

    def test_a_bill_becomes_a_placed_figure(self):
        text = (FIX / "bill_electricity.txt").read_text()
        status, p = self.call("POST", "/api/ingest/bill", body={"text": text, "factor_key": "electricity_uk_grid", "entity_id": "newport", "category": "8", "period": 2026})
        self.assertEqual(status, 200)
        self.assertAlmostEqual(p["figures"][0]["tco2e"], 21.24)
        self.assertEqual(p["bills"][0]["snippets"]["kwh"], "Total consumption 120,000 kWh")

    def test_unknown_kind_and_missing_payload(self):
        self.assertEqual(self.call("POST", "/api/ingest/fax", body={"text": ""})[0], 404)
        self.assertEqual(self.call("POST", "/api/ingest/ledger", body={})[0], 400)


class OverHttp(unittest.TestCase):
    """One real round trip: the adapter, headers, query strings and JSON bodies."""

    @classmethod
    def setUpClass(cls):
        cls.store = Store.open()
        seed(cls.store, today=fx.TODAY)
        cls.httpd = make_server(cls.store, "127.0.0.1", 0, today=fx.TODAY)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.store.close()

    def req(self, method, path, body=None, org=fx.ORG):
        c = HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if org:
            headers["X-Org-Id"] = org
            headers["X-Actor"] = "james"
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        r = c.getresponse()
        return r.status, json.loads(r.read())

    def test_get_with_query_and_post_with_body(self):
        status, p = self.req("GET", "/api/coverage?period=2026&scope1=30000&scope2=12000")
        self.assertEqual(status, 200)
        self.assertIn("result", p)
        status, p = self.req("POST", "/api/engagements/eng_waste_co_2026/transition", {"to": "enriched", "trigger": "http"})
        self.assertEqual(status, 200)
        self.assertEqual(p["audit_row"]["actor"], "james")

    def test_missing_organisation_is_401_and_bad_json_is_400(self):
        self.assertEqual(self.req("GET", "/api/inventory", org=None)[0], 401)
        c = HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/api/counterparties", body="{not json", headers={"X-Org-Id": fx.ORG, "Content-Type": "application/json"})
        self.assertEqual(c.getresponse().status, 400)

    def test_unknown_route_is_404(self):
        self.assertEqual(self.req("GET", "/api/nothing")[0], 404)


if __name__ == "__main__":
    unittest.main()
