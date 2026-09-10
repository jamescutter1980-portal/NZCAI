"""Shared vocabulary for the NZC AI Scope 3 engines.

Every enum member here is a value that also appears in the database schema and
the UI, so the string values are part of the contract. Do not rename them
without a migration.

Reference: docs/product/nzc-ai-scope-3-brief.md (Layer 1)
           docs/product/nzc-ai-scope-3-engagement-brief.md (Layer 2)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Optional


# --------------------------------------------------------------------------
# Boundary
# --------------------------------------------------------------------------


class OperatorRole(str, Enum):
    """How the reporting organisation operates a given outlet.

    This is the single field that decides which scope or Scope 3 category an
    outlet's energy, purchases and waste fall into. Layer 1 section 3.1.
    """

    FRANCHISEE = "franchisee"
    FRANCHISOR = "franchisor"
    RETAIL_PARTNER = "retail_partner"
    LANDLORD_CONCESSION = "landlord_concession"
    FUEL_RETAILER = "fuel_retailer"
    EV_CHARGING_OWNED = "ev_charging_owned"
    EV_CHARGING_PARTNER = "ev_charging_partner"
    HOTEL_FRANCHISEE = "hotel_franchisee"


class ActivityKind(str, Enum):
    """The kind of activity being classified at an outlet.

    Energy is split by fuel because the split decides Scope 1 against Scope 2,
    and the ledger already holds fuel type on the meter.
    """

    ENERGY_FUEL = "energy_fuel"
    ENERGY_ELECTRICITY = "energy_electricity"
    PURCHASES = "purchases"
    WASTE = "waste"
    FUEL_SOLD = "fuel_sold"
    ELECTRICITY_SOLD = "electricity_sold"


class Perspective(str, Enum):
    """Whose inventory we are building.

    The same physical outlet classifies differently for the landlord and the
    occupier. Tenant-paid gas is the landlord's category 13 and the tenant's
    Scope 1.
    """

    OPERATOR = "operator"
    LANDLORD = "landlord"
    OCCUPIER = "occupier"


class Classification(str, Enum):
    """Where an activity lands in the GHG Protocol inventory."""

    SCOPE_1 = "scope_1"
    SCOPE_2 = "scope_2"
    CAT_1 = "cat_1_purchased_goods"
    CAT_5 = "cat_5_waste"
    CAT_11 = "cat_11_use_of_sold_products"
    CAT_13 = "cat_13_downstream_leased"
    CAT_14 = "cat_14_franchises"
    OUT_OF_BOUNDARY = "out_of_boundary"


# --------------------------------------------------------------------------
# Data quality
# --------------------------------------------------------------------------


class Tier(str, Enum):
    """Method tier, best first. Layer 1 section 3.3.

    Tiers A and B are primary data for ESRS E1-6 purposes; C, D and E are
    secondary. The numeric data-quality score runs 1 (best) to 5 (worst).
    """

    A = "A"  # supplier-specific
    B = "B"  # hybrid: supplier-reported, allocated
    C = "C"  # average-data, physical activity
    D = "D"  # spend-based EEIO
    E = "E"  # estimated or extrapolated


#: Data-quality score per tier. 1 is best. Used by uplift and trajectory maths.
DQ_SCORE: dict[Tier, int] = {
    Tier.A: 1,
    Tier.B: 2,
    Tier.C: 3,
    Tier.D: 4,
    Tier.E: 5,
}

#: Tiers that count as primary data under ESRS E1-6.
PRIMARY_TIERS: frozenset[Tier] = frozenset({Tier.A, Tier.B})


def is_primary(tier: Tier) -> bool:
    """True where the tier counts as primary data for ESRS E1-6."""
    return tier in PRIMARY_TIERS


# --------------------------------------------------------------------------
# Scope 3 categories
# --------------------------------------------------------------------------


class Category(str, Enum):
    """The fifteen GHG Protocol Scope 3 categories.

    All fifteen are screened every year even where the answer is "not
    relevant"; SBTi requires a quantitative screen, not an assertion.
    """

    C1_PURCHASED_GOODS = "1"
    C2_CAPITAL_GOODS = "2"
    C3_FUEL_ENERGY = "3"
    C4_UPSTREAM_TRANSPORT = "4"
    C5_WASTE = "5"
    C6_BUSINESS_TRAVEL = "6"
    C7_COMMUTING = "7"
    C8_UPSTREAM_LEASED = "8"
    C9_DOWNSTREAM_TRANSPORT = "9"
    C10_PROCESSING = "10"
    C11_USE_OF_SOLD = "11"
    C12_END_OF_LIFE = "12"
    C13_DOWNSTREAM_LEASED = "13"
    C14_FRANCHISES = "14"
    C15_INVESTMENTS = "15"


@dataclass(frozen=True)
class Figure:
    """One computed emissions figure, with the provenance that justifies it.

    A figure never carries a value the engines did not compute. `factor_source`
    and `factor_version` are mandatory because an assurance provider will ask
    for both, and `document_id` is what makes the lineage clickable.
    """

    category: Category
    tco2e: float
    tier: Tier
    factor_source: str
    factor_version: str
    counterparty_id: Optional[str] = None
    document_id: Optional[str] = None
    achievable_tier: Optional[Tier] = None

    def __post_init__(self) -> None:
        if self.tco2e < 0:
            raise ValueError(f"tco2e must not be negative, got {self.tco2e}")
        if not self.factor_source or not self.factor_version:
            raise ValueError("every figure must carry a factor source and version")


# --------------------------------------------------------------------------
# Counterparties and engagement
# --------------------------------------------------------------------------


class RelationshipRole(str, Enum):
    """A counterparty's role in the value chain.

    A counterparty holds a *set* of these, not one. Starbucks at a motorway
    services operator is simultaneously a franchisor and a supplier.
    """

    SUPPLIER = "supplier"
    DISTRIBUTOR = "distributor"
    FRANCHISOR = "franchisor"
    FRANCHISEE = "franchisee"
    CONCESSION_TENANT = "concession_tenant"
    LANDLORD = "landlord"
    WASTE_CONTRACTOR = "waste_contractor"
    LOGISTICS = "logistics"
    FUEL_SUPPLIER = "fuel_supplier"
    CHARGING_PARTNER = "charging_partner"
    CUSTOMER = "customer"
    LENDER = "lender"
    PARENT = "parent"


#: Roles where the counterparty holds power over the reporting organisation.
#: Requests to these are unlikely to be answered on demand, so the engagement
#: plan routes them differently rather than queuing a doomed chase.
DOMINANT_ROLES: frozenset[RelationshipRole] = frozenset(
    {
        RelationshipRole.FRANCHISOR,
        RelationshipRole.LANDLORD,
        RelationshipRole.PARENT,
        RelationshipRole.LENDER,
    }
)


class Direction(str, Enum):
    UPSTREAM = "upstream"
    DOWNSTREAM = "downstream"
    BOTH = "both"


class EngagementState(str, Enum):
    """Lifecycle of one data need, for one relationship, for one period.

    Layer 2 section 4. Every transition writes an audit row.
    """

    UNIDENTIFIED = "unidentified"
    IDENTIFIED = "identified"
    ENRICHED = "enriched"
    SCOPED = "scoped"
    CONTACTED = "contacted"
    ENGAGED = "engaged"
    RESPONDING = "responding"
    PARTIAL = "partial"
    COMPLETE = "complete"
    VERIFIED = "verified"
    DECLINED = "declined"
    UNREACHABLE = "unreachable"
    LAPSED = "lapsed"
    SUPERSEDED = "superseded"


class DeclineReason(str, Enum):
    """Why a counterparty refused. Recorded, not editorialised.

    VSME_CAP is a lawful refusal: under Omnibus I a counterparty below the
    1,000-employee threshold may decline anything beyond the voluntary SME
    standard, and the engine must stop asking rather than escalate.
    """

    VSME_CAP = "vsme_cap"
    COMMERCIAL_CONFIDENTIALITY = "commercial_confidentiality"
    NO_CAPABILITY = "no_capability"
    NO_REASON_GIVEN = "no_reason_given"


class ContactRung(str, Enum):
    """The escalation ladder. Escalate the person, never the frequency."""

    DAY_TO_DAY = "day_to_day"
    ACCOUNT_MANAGER = "account_manager"
    SUSTAINABILITY_LEAD = "sustainability_lead"
    COMMERCIAL = "commercial"


class RequestTemplate(str, Enum):
    """What we ask for. Speak the standards, do not invent a questionnaire."""

    VSME = "vsme"
    PACT = "pact"
    GHG_CATEGORY = "ghg_category"
    CONCESSION_ENERGY = "concession_energy"
    WASTE_RETURN = "waste_return"
    LOGISTICS_RETURN = "logistics_return"


#: Employee count at or above which a counterparty may be asked for more than
#: the voluntary SME standard. Omnibus I, Directive (EU) 2026/470.
VSME_EMPLOYEE_THRESHOLD = 1000


@dataclass(frozen=True)
class Counterparty:
    """A legal entity in the value chain, with what we know about it."""

    id: str
    name: str
    roles: frozenset[RelationshipRole]
    company_number: Optional[str] = None
    employee_band: Optional[int] = None
    turnover_gbp: Optional[float] = None
    has_public_report: bool = False
    is_cdp_responder: bool = False
    has_validated_target: bool = False
    has_named_contact: bool = False
    responded_before: bool = False
    contractual_data_right: bool = False
    emissions_intensive_commodity: Optional[str] = None
    contract_end: Optional[date] = None

    @property
    def is_dominant(self) -> bool:
        """True where this counterparty holds power over us, not the reverse."""
        return bool(self.roles & DOMINANT_ROLES)

    @property
    def may_be_asked_beyond_vsme(self) -> bool:
        """False where the voluntary SME cap applies.

        Unknown employee count is treated as below the threshold: asking for
        less than we might be entitled to is recoverable, over-asking a small
        supplier is not.
        """
        if self.employee_band is None:
            return False
        return self.employee_band >= VSME_EMPLOYEE_THRESHOLD


# --------------------------------------------------------------------------
# Documents
# --------------------------------------------------------------------------


class DocumentType(str, Enum):
    """Layer 2 section 7.2. Each type has an extraction schema and a validity rule."""

    SUSTAINABILITY_REPORT = "sustainability_report"
    CDP_RESPONSE = "cdp_response"
    SBTI_TARGET = "sbti_target"
    EPD = "epd"
    PACT_PAYLOAD = "pact_payload"
    VSME_RETURN = "vsme_return"
    ISO_CERTIFICATE = "iso_certificate"
    ASSURANCE_STATEMENT = "assurance_statement"
    INVOICE = "invoice"
    WASTE_TRANSFER_NOTE = "waste_transfer_note"
    UTILITY_BILL = "utility_bill"
    AGREEMENT = "agreement"
    FRANCHISOR_REQUEST = "franchisor_request"


class Confidentiality(str, Enum):
    """Enforced on read and on export, not merely recorded."""

    PUBLIC = "public"
    NDA = "nda"
    CLIENT_ONLY = "client_only"
    CONSENTED_REUSE = "consented_reuse"


class DocumentStatus(str, Enum):
    CURRENT = "current"
    STALE = "stale"
    EXPIRED = "expired"


@dataclass(frozen=True)
class Document:
    """An artefact received, uploaded or harvested, with what it supports."""

    id: str
    counterparty_id: str
    doc_type: DocumentType
    issue_date: date
    confidentiality: Confidentiality = Confidentiality.CLIENT_ONLY
    period_covered: Optional[int] = None
    valid_to: Optional[date] = None
    supports_figures: tuple[str, ...] = field(default_factory=tuple)
