"""Boundary rules. Covers Layer 1 acceptance criteria 2 and 3."""

from __future__ import annotations

import unittest

from engines.boundary import classify, franchisor_mirror
from engines.types import (
    ActivityKind as A,
    Classification as C,
    OperatorRole as Role,
    Perspective,
)


class OperatedOutlets(unittest.TestCase):
    def test_franchisee_energy_splits_by_fuel(self):
        self.assertIs(
            classify(Role.FRANCHISEE, A.ENERGY_FUEL).classification, C.SCOPE_1
        )
        self.assertIs(
            classify(Role.FRANCHISEE, A.ENERGY_ELECTRICITY).classification, C.SCOPE_2
        )

    def test_franchisee_purchases_and_waste_are_ours(self):
        self.assertIs(classify(Role.FRANCHISEE, A.PURCHASES).classification, C.CAT_1)
        self.assertIs(classify(Role.FRANCHISEE, A.WASTE).classification, C.CAT_5)

    def test_franchisee_placement_names_the_franchisor_mirror(self):
        placement = classify(Role.FRANCHISEE, A.ENERGY_FUEL)
        self.assertIn("category 14", placement.note)

    def test_retail_partner_and_hotel_behave_as_operated(self):
        for role in (Role.RETAIL_PARTNER, Role.HOTEL_FRANCHISEE):
            with self.subTest(role=role):
                self.assertIs(classify(role, A.PURCHASES).classification, C.CAT_1)
                self.assertIs(
                    classify(role, A.ENERGY_ELECTRICITY).classification, C.SCOPE_2
                )


class Franchisor(unittest.TestCase):
    def test_everything_lands_in_category_14(self):
        for activity in (A.ENERGY_FUEL, A.ENERGY_ELECTRICITY, A.PURCHASES, A.WASTE):
            with self.subTest(activity=activity):
                self.assertIs(
                    classify(Role.FRANCHISOR, activity).classification, C.CAT_14
                )


class TenantedOutlets(unittest.TestCase):
    def test_concession_energy_is_category_13(self):
        placement = classify(Role.LANDLORD_CONCESSION, A.ENERGY_ELECTRICITY)
        self.assertIs(placement.classification, C.CAT_13)
        self.assertTrue(placement.contract_basis_required)

    def test_concession_purchases_are_out_of_boundary(self):
        placement = classify(Role.LANDLORD_CONCESSION, A.PURCHASES)
        self.assertIs(placement.classification, C.OUT_OF_BOUNDARY)
        self.assertFalse(placement.in_boundary)

    def test_concession_waste_depends_on_who_holds_the_contract(self):
        without = classify(Role.LANDLORD_CONCESSION, A.WASTE)
        self.assertIs(without.classification, C.OUT_OF_BOUNDARY)

        with_contract = classify(
            Role.LANDLORD_CONCESSION, A.WASTE, operator_contracts_waste=True
        )
        self.assertIs(with_contract.classification, C.CAT_5)

    def test_charging_partner_without_a_lease_is_outside_the_boundary(self):
        placement = classify(
            Role.EV_CHARGING_PARTNER, A.ENERGY_ELECTRICITY, space_leased=False
        )
        self.assertIs(placement.classification, C.OUT_OF_BOUNDARY)
        self.assertTrue(placement.contract_basis_required)


class RoleChange(unittest.TestCase):
    """Layer 1 acceptance 2: re-roling an outlet re-scopes it."""

    def test_franchisee_to_landlord_moves_energy_and_drops_purchases(self):
        before_energy = classify(Role.FRANCHISEE, A.ENERGY_ELECTRICITY)
        after_energy = classify(Role.LANDLORD_CONCESSION, A.ENERGY_ELECTRICITY)
        self.assertIs(before_energy.classification, C.SCOPE_2)
        self.assertIs(after_energy.classification, C.CAT_13)

        before_purchases = classify(Role.FRANCHISEE, A.PURCHASES)
        after_purchases = classify(Role.LANDLORD_CONCESSION, A.PURCHASES)
        self.assertIs(before_purchases.classification, C.CAT_1)
        self.assertIs(after_purchases.classification, C.OUT_OF_BOUNDARY)


class PerspectiveFlip(unittest.TestCase):
    """The same tenanted outlet, seen from both sides of the lease."""

    def test_landlord_sees_category_13_and_occupier_sees_scope_1(self):
        landlord = classify(
            Role.LANDLORD_CONCESSION, A.ENERGY_FUEL, Perspective.LANDLORD
        )
        occupier = classify(
            Role.LANDLORD_CONCESSION, A.ENERGY_FUEL, Perspective.OCCUPIER
        )
        self.assertIs(landlord.classification, C.CAT_13)
        self.assertIs(occupier.classification, C.SCOPE_1)

    def test_occupier_owns_the_purchases_the_landlord_does_not(self):
        occupier = classify(
            Role.LANDLORD_CONCESSION, A.PURCHASES, Perspective.OCCUPIER
        )
        self.assertIs(occupier.classification, C.CAT_1)


class FuelAndElectricitySold(unittest.TestCase):
    """Layer 1 acceptance 3."""

    def test_fuel_sold_is_category_11_and_cites_c22(self):
        placement = classify(Role.FUEL_RETAILER, A.FUEL_SOLD)
        self.assertIs(placement.classification, C.CAT_11)
        self.assertIn("C22", placement.note)

    def test_fuel_bought_for_resale_is_category_1_with_a_contract_basis(self):
        placement = classify(Role.FUEL_RETAILER, A.PURCHASES)
        self.assertIs(placement.classification, C.CAT_1)
        self.assertTrue(placement.contract_basis_required)
        self.assertIn("well-to-tank", placement.note)

    def test_fuel_sold_is_meaningless_for_a_non_retailer(self):
        with self.assertRaises(ValueError):
            classify(Role.FRANCHISEE, A.FUEL_SOLD)

    def test_resold_electricity_does_not_raise_a_second_line(self):
        placement = classify(Role.EV_CHARGING_OWNED, A.ELECTRICITY_SOLD)
        self.assertIs(placement.classification, C.OUT_OF_BOUNDARY)
        self.assertIn("double count", placement.note)

    def test_pass_through_election_must_be_evidenced(self):
        placement = classify(
            Role.EV_CHARGING_OWNED, A.ELECTRICITY_SOLD, pass_through_elected=True
        )
        self.assertIs(placement.classification, C.OUT_OF_BOUNDARY)
        self.assertTrue(placement.contract_basis_required)

    def test_owned_charging_electricity_is_scope_2(self):
        self.assertIs(
            classify(Role.EV_CHARGING_OWNED, A.ENERGY_ELECTRICITY).classification,
            C.SCOPE_2,
        )


class Mirror(unittest.TestCase):
    def test_a_franchised_outlet_is_the_franchisors_category_14(self):
        self.assertIs(franchisor_mirror(Role.FRANCHISEE), C.CAT_14)
        self.assertIs(franchisor_mirror(Role.HOTEL_FRANCHISEE), C.CAT_14)

    def test_a_concession_is_the_tenants_own_scope_1(self):
        self.assertIs(franchisor_mirror(Role.LANDLORD_CONCESSION), C.SCOPE_1)

    def test_no_mirror_where_none_arises(self):
        self.assertIsNone(franchisor_mirror(Role.RETAIL_PARTNER))


if __name__ == "__main__":
    unittest.main()
