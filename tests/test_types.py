"""Derived properties on the shared vocabulary.

Value-chain direction is the field that makes the counterparty graph a graph
rather than a supplier list, so its derivation is worth pinning.
"""

from __future__ import annotations

import unittest

from engines.types import (
    ROLE_DIRECTION,
    Counterparty,
    Direction,
    RelationshipRole as R,
)
from tests import fixtures as fx


class RoleDirectionMap(unittest.TestCase):
    def test_every_role_has_a_direction(self):
        missing = [role for role in R if role not in ROLE_DIRECTION]
        self.assertEqual(missing, [], f"roles with no direction: {missing}")

    def test_a_franchisor_is_the_only_role_running_both_ways(self):
        both = [r for r, d in ROLE_DIRECTION.items() if d is Direction.BOTH]
        self.assertEqual(both, [R.FRANCHISOR])

    def test_we_lease_from_a_landlord_so_they_are_upstream(self):
        self.assertIs(ROLE_DIRECTION[R.LANDLORD], Direction.UPSTREAM)

    def test_we_report_to_a_parent_so_they_are_downstream(self):
        self.assertIs(ROLE_DIRECTION[R.PARENT], Direction.DOWNSTREAM)
        self.assertIs(ROLE_DIRECTION[R.LENDER], Direction.DOWNSTREAM)


class Directions(unittest.TestCase):
    def test_a_plain_supplier_is_upstream_only(self):
        self.assertEqual(fx.BEEF_CO.directions, frozenset({Direction.UPSTREAM}))

    def test_a_franchisor_and_supplier_spans_the_value_chain(self):
        self.assertIn(Direction.BOTH, fx.STARBUCKS.directions)
        self.assertTrue(fx.STARBUCKS.spans_value_chain)

    def test_one_upstream_and_one_downstream_role_also_spans_it(self):
        hybrid = Counterparty(
            id="hybrid",
            name="Both Ways Ltd",
            roles=frozenset({R.SUPPLIER, R.CUSTOMER}),
        )
        self.assertEqual(
            hybrid.directions, frozenset({Direction.UPSTREAM, Direction.DOWNSTREAM})
        )
        self.assertTrue(hybrid.spans_value_chain)

    def test_a_single_direction_does_not_span_it(self):
        self.assertFalse(fx.BEEF_CO.spans_value_chain)
        self.assertFalse(fx.APPLEGREEN.spans_value_chain)

    def test_a_charging_concession_is_downstream(self):
        self.assertEqual(fx.CHARGING.directions, frozenset({Direction.DOWNSTREAM}))

    def test_position_is_not_the_same_question_as_who_asks_whom(self):
        """A concession tenant sits downstream, yet we are the one asking."""
        self.assertEqual(fx.CHARGING.directions, frozenset({Direction.DOWNSTREAM}))
        self.assertFalse(fx.CHARGING.is_dominant)
        self.assertTrue(fx.YUM.is_dominant)


class VsmeThreshold(unittest.TestCase):
    def test_an_unknown_employee_count_is_treated_as_small(self):
        unknown = Counterparty(
            id="unknown", name="Unknown Ltd", roles=frozenset({R.SUPPLIER})
        )
        self.assertFalse(unknown.may_be_asked_beyond_vsme)

    def test_the_threshold_is_inclusive(self):
        at_threshold = Counterparty(
            id="at", name="At Ltd", roles=frozenset({R.SUPPLIER}), employee_band=1000
        )
        below = Counterparty(
            id="below", name="Below Ltd", roles=frozenset({R.SUPPLIER}), employee_band=999
        )
        self.assertTrue(at_threshold.may_be_asked_beyond_vsme)
        self.assertFalse(below.may_be_asked_beyond_vsme)


if __name__ == "__main__":
    unittest.main()
