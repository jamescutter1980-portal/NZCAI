"""Ingestion: external shapes in, engine inputs out, bad rows reported not lost."""

from __future__ import annotations

import json
import unittest
from datetime import date
from pathlib import Path

from engines.activity import calculate
from engines.factors import FactorLibrary
from engines.partner import AllocationBasis, allocate, apply_footprint
from engines.types import Category, DocumentType, Tier
from ingest.activity import parse_activity_csv
from ingest.bill import parse_bill, parse_bill_text
from ingest.ledger import parse_ledger_csv
from ingest.pact import parse_pact
from ingest.vsme import parse_vsme

FIX = Path("tests/fixtures_files")
ORG = "org_welcome_shaped"


class Ledger(unittest.TestCase):
    def setUp(self):
        self.r = parse_ledger_csv((FIX / "ledger.csv").read_text(), source="ledger.csv")

    def test_good_rows_parse_and_bad_rows_are_reported_with_their_line(self):
        self.assertEqual(len(self.r.items), 4)
        self.assertEqual([e.where for e in self.r.errors], ["ledger.csv line 6", "ledger.csv line 7"])
        self.assertIn("no supplier", self.r.errors[0].message)
        self.assertIn("not a number", self.r.errors[1].message)

    def test_finance_column_names_and_number_formats_are_accepted(self):
        first = self.r.items[0]
        self.assertEqual(first.id, "INV-001")
        self.assertEqual(first.gl_code, "5000")
        self.assertEqual(first.supplier_name, "BIDFOOD LTD")
        self.assertAlmostEqual(first.amount_gbp, 12_450.0)

    def test_three_date_formats_give_the_spend_year(self):
        self.assertEqual({l.spend_year for l in self.r.items}, {2026})

    def test_a_credit_note_becomes_zero_spend_and_keeps_its_amount_in_the_description(self):
        credit = self.r.items[3]
        self.assertEqual(credit.amount_gbp, 0.0)
        self.assertIn("credit -450.00", credit.description)

    def test_a_duplicate_line_id_is_refused(self):
        r = parse_ledger_csv("id,supplier,amount,year\nA,X,1,2026\nA,Y,2,2026\n")
        self.assertEqual(len(r.items), 1)
        self.assertIn("duplicate", r.errors[0].message)

    def test_no_year_and_no_default_is_an_error_not_a_guess(self):
        r = parse_ledger_csv("supplier,amount\nX,1\n")
        self.assertEqual(r.items, [])
        self.assertIn("no year", r.errors[0].message)
        self.assertEqual(parse_ledger_csv("supplier,amount\nX,1\n", default_year=2025).items[0].spend_year, 2025)


class Activity(unittest.TestCase):
    def setUp(self):
        self.lib = FactorLibrary.load()
        self.r = parse_activity_csv((FIX / "activity.csv").read_text(), source="activity.csv", library=self.lib)

    def test_rows_parse_with_category_override_and_evidence(self):
        self.assertEqual(len(self.r.items), 3)
        rail, car, elec = self.r.items
        self.assertIs(rail.category, Category.C6_BUSINESS_TRAVEL)
        self.assertEqual(rail.quantity, 48_200)
        self.assertEqual(elec.document_id, "bill-0042")
        self.assertIs(elec.category, Category.C8_UPSTREAM_LEASED)

    def test_an_unknown_factor_key_is_caught_at_ingestion(self):
        messages = [e.message for e in self.r.errors]
        self.assertTrue(any("not in the library" in m for m in messages))
        self.assertTrue(any("no quantity" in m for m in messages))

    def test_parsed_lines_calculate_with_full_lineage(self):
        figs = [calculate(l, self.lib) for l in self.r.items]
        self.assertTrue(all(f.has_lineage for f in figs))
        self.assertAlmostEqual(figs[2].tco2e, 120_000 * 0.177 / 1000, places=6)


class Pact(unittest.TestCase):
    def test_v3_payload_gives_a_verified_footprint_and_a_document(self):
        r = parse_pact((FIX / "pact_v3.json").read_bytes(), counterparty_id="bidfood", owner_org_id=ORG)
        self.assertTrue(r.ok, r.errors)
        [p] = r.items
        self.assertEqual(p.footprint.item_key, "urn:sku:bidfood:chicken-frozen-2kg")
        self.assertAlmostEqual(p.footprint.kgco2e_per_unit, 6.4)
        self.assertEqual(p.footprint.unit, "kg")
        self.assertTrue(p.footprint.verified)
        self.assertEqual(p.footprint.version, "PACT 3.0.3 v2")
        self.assertIs(p.document.doc_type, DocumentType.PACT_PAYLOAD)
        self.assertEqual(p.document.valid_to, date(2028, 12, 31))
        self.assertEqual(p.document.period_covered, 2025)
        self.assertEqual(p.document.owner_org_id, ORG)
        self.assertEqual(p.footprint.document_id, p.document.id)

    def test_v2_field_names_and_unitary_amount_are_normalised(self):
        r = parse_pact((FIX / "pact_v2.json").read_bytes(), counterparty_id="dairy_co", owner_org_id=ORG)
        [p] = r.items
        self.assertEqual(p.footprint.unit, "litre")
        self.assertAlmostEqual(p.footprint.kgco2e_per_unit, 1.3)  # 2.6 per 2 litres
        self.assertFalse(p.footprint.verified)
        self.assertEqual(p.document.valid_to, date(2027, 6, 1))

    def test_biogenic_is_excluded_unless_asked(self):
        raw = (FIX / "pact_v3.json").read_bytes()
        incl = parse_pact(raw, counterparty_id="bidfood", owner_org_id=ORG, include_biogenic=True).items[0]
        self.assertAlmostEqual(incl.footprint.kgco2e_per_unit, 6.9)

    def test_a_deprecated_or_malformed_footprint_is_refused(self):
        obj = json.loads((FIX / "pact_v3.json").read_text())
        obj["status"] = "Deprecated"
        r = parse_pact(json.dumps(obj), counterparty_id="bidfood", owner_org_id=ORG)
        self.assertEqual(r.items, [])
        self.assertIn("deprecated", r.errors[0].message)
        obj["status"] = "Active"
        obj["pcf"]["declaredUnitOfMeasurement"] = "furlong"
        self.assertIn("unrecognised declared unit", parse_pact(json.dumps(obj), counterparty_id="b", owner_org_id=ORG).errors[0].message)
        self.assertIn("not JSON", parse_pact(b"{", counterparty_id="b", owner_org_id=ORG).errors[0].message)

    def test_a_listing_parses_each_entry(self):
        listing = {"data": [json.loads((FIX / "pact_v3.json").read_text()), json.loads((FIX / "pact_v2.json").read_text())]}
        r = parse_pact(json.dumps(listing), counterparty_id="x", owner_org_id=ORG)
        self.assertEqual(len(r.items), 2)

    def test_the_footprint_applies_as_a_tier_a_figure(self):
        [p] = parse_pact((FIX / "pact_v3.json").read_bytes(), counterparty_id="bidfood", owner_org_id=ORG).items
        fig = apply_footprint(p.footprint, 10_000, "kg")
        self.assertIs(fig.tier, Tier.A)
        self.assertAlmostEqual(fig.tco2e, 64.0)
        self.assertIn("PACT", fig.factor_source)


class Vsme(unittest.TestCase):
    def _parse(self, name):
        return parse_vsme((FIX / name).read_bytes(), counterparty_id="bakery", counterparty_name="Bakery",
                          period=2025, owner_org_id=ORG)

    def test_the_efrag_xlsx_template_reads_by_label(self):
        r = self._parse("vsme.xlsx")
        self.assertTrue(r.ok, r.errors)
        [v] = r.items
        self.assertEqual(v.format, "xlsx")
        self.assertAlmostEqual(v.scope1_tco2e, 1250.5)
        self.assertAlmostEqual(v.scope2_location_tco2e, 310)
        self.assertAlmostEqual(v.scope2_market_tco2e, 290)
        self.assertEqual(v.employees, 40)
        self.assertAlmostEqual(v.turnover, 6_500_000)
        self.assertAlmostEqual(v.energy_mwh, 4120)
        self.assertIs(v.document.doc_type, DocumentType.VSME_RETURN)
        self.assertEqual(v.document.period_covered, 2025)

    def test_xbrl_json_reads_the_same_values_and_ignores_dimensional_facts(self):
        [v] = self._parse("vsme.json").items
        self.assertEqual(v.format, "xbrl-json")
        self.assertAlmostEqual(v.scope1_tco2e, 1250.5)   # not the 9999 site-level fact
        self.assertAlmostEqual(v.scope2_market_tco2e, 290)
        self.assertEqual(v.employees, 40)

    def test_both_formats_agree(self):
        a, b = self._parse("vsme.xlsx").items[0], self._parse("vsme.json").items[0]
        for f in ("scope1_tco2e", "scope2_location_tco2e", "scope2_market_tco2e", "employees"):
            self.assertEqual(getattr(a, f), getattr(b, f), f)

    def test_market_based_is_preferred_for_allocation(self):
        [v] = self._parse("vsme.xlsx").items
        self.assertEqual(v.scope2_tco2e, 290)
        resp = v.to_partner_response(our_share=0.1, basis=AllocationBasis.REVENUE_SHARE)
        self.assertEqual(resp.document_id, v.document.id)
        fig = allocate(resp)
        self.assertIs(fig.tier, Tier.B)
        self.assertAlmostEqual(fig.tco2e, (1250.5 + 290) * 0.1)

    def test_a_partial_return_is_kept_but_flagged_and_cannot_allocate(self):
        r = self._parse("vsme_partial.xlsx")
        [v] = r.items
        self.assertFalse(r.ok)
        self.assertAlmostEqual(v.scope1_tco2e, 100)
        self.assertIsNone(v.scope2_tco2e)
        self.assertEqual(v.employees, 12)
        self.assertFalse(v.complete_for_allocation)
        with self.assertRaises(ValueError):
            v.to_partner_response(our_share=0.1, basis=AllocationBasis.REVENUE_SHARE)

    def test_garbage_is_an_error_not_an_exception(self):
        r = parse_vsme(b"hello", counterparty_id="b", counterparty_name="B", period=2025, owner_org_id=ORG)
        self.assertEqual(r.items, [])
        self.assertIn("neither an xlsx nor JSON", r.errors[0].message)

    def test_the_document_hash_ties_the_return_to_its_bytes(self):
        import hashlib
        raw = (FIX / "vsme.xlsx").read_bytes()
        [v] = self._parse("vsme.xlsx").items
        self.assertEqual(v.document.sha256, hashlib.sha256(raw).hexdigest())


class Bill(unittest.TestCase):
    def test_an_electricity_bill_reads_consumption_period_and_meter(self):
        r = parse_bill_text((FIX / "bill_electricity.txt").read_text(), source="bill_electricity.txt")
        self.assertTrue(r.ok, r.errors)
        [b] = r.items
        self.assertEqual(b.fuel, "electricity")
        self.assertEqual(b.kwh, 120_000)
        self.assertEqual((b.period_start, b.period_end), (date(2026, 2, 1), date(2026, 2, 28)))
        self.assertEqual(b.days, 28)
        self.assertEqual(b.meter_ref, "123456781012345678901")
        self.assertEqual(b.supplier, "edf")
        self.assertAlmostEqual(b.total_gbp, 24_318.60)
        self.assertIn("Total consumption 120,000 kWh", b.snippets["kwh"])

    def test_a_gas_bill_is_recognised_by_its_mprn(self):
        [b] = parse_bill_text((FIX / "bill_gas.txt").read_text()).items
        self.assertEqual(b.fuel, "gas")
        self.assertEqual(b.kwh, 44_000)
        self.assertEqual(b.period_end, date(2026, 3, 31))
        self.assertEqual(b.meter_ref, "8812345")

    def test_the_extract_becomes_an_activity_line_that_calculates(self):
        [b] = parse_bill_text((FIX / "bill_electricity.txt").read_text()).items
        line = b.to_activity_line(factor_key="electricity_uk_grid", entity_id="newport_pagnell", document_id="bill-0042",
                                  category=Category.C8_UPSTREAM_LEASED)
        fig = calculate(line, FactorLibrary.load())
        self.assertAlmostEqual(fig.tco2e, 21.24)
        self.assertEqual(fig.document_id, "bill-0042")

    def test_missing_consumption_or_period_is_reported(self):
        r = parse_bill_text("Some invoice with no useful numbers. Amount due £10.00")
        self.assertEqual({e.message for e in r.errors}, {"no kWh consumption found", "no supply period found"})
        self.assertFalse(r.items[0].usable)
        with self.assertRaises(ValueError):
            r.items[0].to_activity_line(factor_key="electricity_uk_grid", entity_id="x", document_id="d")

    def test_a_period_that_ends_before_it_starts_is_refused(self):
        r = parse_bill_text("Consumption 100 kWh\nPeriod 28/02/2026 to 01/02/2026")
        self.assertIn("ends before it starts", r.errors[0].message)

    def test_the_pdf_extractor_is_injected_and_its_failure_is_contained(self):
        good = parse_bill(b"%PDF", extract_text=lambda raw: (FIX / "bill_gas.txt").read_text())
        self.assertEqual(good.items[0].kwh, 44_000)
        def boom(raw):
            raise RuntimeError("no pdf library")
        bad = parse_bill(b"%PDF", extract_text=boom, source="x.pdf")
        self.assertEqual(bad.items, [])
        self.assertIn("text extraction failed", bad.errors[0].message)


if __name__ == "__main__":
    unittest.main()
