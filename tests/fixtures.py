"""A motorway services operator, shaped like the client this was designed for.

Thirty-odd service areas under franchised catering brands, a supermarket
concession, hotels, a forecourt and a charging hub. The numbers are
illustrative but the proportions are not: fuel sold dominates the footprint,
which is exactly why SBTi criterion C22 bites.
"""

from __future__ import annotations

from datetime import date

from engines.quality import uplift_tonnes
from engines.types import (
    Category,
    Confidentiality,
    Counterparty,
    Document,
    DocumentType,
    Figure,
    RelationshipRole as R,
    Tier,
)

TODAY = date(2026, 9, 10)
REPORTING_PERIOD = 2026

#: The client organisation whose inventory this is.
ORG = "org_welcome_shaped"

#: A second client of the same consultancy, for the cross-organisation
#: disclosure tests. It must never see the first client's documents.
OTHER_ORG = "org_other_client"

DESNZ = ("DESNZ", "2025")
CEDA = ("Open CEDA", "2024")
SUPPLIER = ("Supplier PCF", "2026")


# --------------------------------------------------------------------------
# Counterparties
# --------------------------------------------------------------------------

YUM = Counterparty(
    id="yum",
    name="Yum! Brands",
    roles=frozenset({R.FRANCHISOR}),
    employee_band=40000,
    has_public_report=True,
    is_cdp_responder=True,
    has_validated_target=True,
    has_named_contact=True,
)

STARBUCKS = Counterparty(
    id="starbucks",
    name="Starbucks",
    # The counterparty that makes the case for role sets: it licenses us a
    # brand and sells us coffee, so it is upstream and downstream at once.
    roles=frozenset({R.FRANCHISOR, R.SUPPLIER}),
    employee_band=380000,
    has_public_report=True,
    is_cdp_responder=True,
    has_validated_target=True,
    has_named_contact=True,
)

BIDFOOD = Counterparty(
    id="bidfood",
    name="Bidfood",
    roles=frozenset({R.DISTRIBUTOR, R.SUPPLIER}),
    company_number="00832890",
    employee_band=6000,
    turnover_gbp=3_200_000_000,
    has_public_report=True,
    has_named_contact=True,
    responded_before=True,
    contract_end=date(2027, 3, 31),
)

BEEF_CO = Counterparty(
    id="beef_co",
    name="Northern Beef Supply",
    roles=frozenset({R.SUPPLIER}),
    employee_band=1400,
    turnover_gbp=180_000_000,
    emissions_intensive_commodity="livestock",
    has_named_contact=True,
)

DAIRY_CO = Counterparty(
    id="dairy_co",
    name="Vale Dairies",
    roles=frozenset({R.SUPPLIER}),
    employee_band=2200,
    turnover_gbp=340_000_000,
    emissions_intensive_commodity="dairy",
    has_public_report=True,
    has_validated_target=True,
    has_named_contact=True,
    responded_before=True,
)

BAKERY = Counterparty(
    id="bakery",
    name="Pennine Bakery",
    # Below the employee threshold, so it may lawfully decline anything beyond
    # the voluntary SME standard.
    roles=frozenset({R.SUPPLIER}),
    employee_band=40,
    turnover_gbp=6_000_000,
)

WASTE_CO = Counterparty(
    id="waste_co",
    name="Reconomy",
    roles=frozenset({R.WASTE_CONTRACTOR}),
    employee_band=2800,
    turnover_gbp=420_000_000,
    has_named_contact=True,
    responded_before=True,
    contractual_data_right=True,
)

CHARGING = Counterparty(
    id="charging",
    name="GRIDSERVE",
    roles=frozenset({R.CHARGING_PARTNER, R.CONCESSION_TENANT}),
    employee_band=600,
    turnover_gbp=90_000_000,
    has_named_contact=True,
)

APPLEGREEN = Counterparty(
    id="applegreen",
    name="Applegreen",
    roles=frozenset({R.PARENT}),
    employee_band=15000,
    has_public_report=True,
    has_named_contact=True,
)

COUNTERPARTIES: dict[str, Counterparty] = {
    c.id: c
    for c in (
        YUM,
        STARBUCKS,
        BIDFOOD,
        BEEF_CO,
        DAIRY_CO,
        BAKERY,
        WASTE_CO,
        CHARGING,
        APPLEGREEN,
    )
}

#: What we spend with each counterparty in a year, for the leverage term.
ANNUAL_SPEND: dict[str, float] = {
    "yum": 0.0,
    "starbucks": 4_500_000,
    "bidfood": 62_000_000,
    "beef_co": 14_000_000,
    "dairy_co": 9_000_000,
    "bakery": 900_000,
    "waste_co": 3_100_000,
    "charging": 0.0,
    "applegreen": 0.0,
}


# --------------------------------------------------------------------------
# Operational emissions
# --------------------------------------------------------------------------

SCOPE_1 = 22_000.0
SCOPE_2 = 14_000.0


# --------------------------------------------------------------------------
# The Scope 3 inventory
# --------------------------------------------------------------------------


def _figure(
    category: Category,
    tco2e: float,
    tier: Tier,
    factor: tuple[str, str],
    counterparty_id: str | None = None,
    achievable: Tier | None = None,
) -> Figure:
    return Figure(
        category=category,
        tco2e=tco2e,
        tier=tier,
        factor_source=factor[0],
        factor_version=factor[1],
        counterparty_id=counterparty_id,
        achievable_tier=achievable,
    )


#: Fuel sold dwarfs everything else, which is the shape of a forecourt
#: business and the reason category 11 cannot be quietly left out.
FIGURES: list[Figure] = [
    # Category 11: litres sold times a combustion factor. Already activity
    # data, so there is no better tier to reach.
    _figure(Category.C11_USE_OF_SOLD, 620_000, Tier.C, DESNZ, achievable=Tier.C),
    # Category 1: the food and packaging book, mostly spend-based today and
    # mostly reachable with supplier data. This is where the uplift sits.
    _figure(Category.C1_PURCHASED_GOODS, 74_000, Tier.D, CEDA, "bidfood", Tier.A),
    _figure(Category.C1_PURCHASED_GOODS, 48_000, Tier.D, CEDA, "beef_co", Tier.A),
    _figure(Category.C1_PURCHASED_GOODS, 21_000, Tier.C, DESNZ, "dairy_co", Tier.A),
    _figure(Category.C1_PURCHASED_GOODS, 14_000, Tier.B, SUPPLIER, "starbucks", Tier.A),
    _figure(Category.C1_PURCHASED_GOODS, 3_200, Tier.D, CEDA, "bakery", Tier.C),
    _figure(Category.C1_PURCHASED_GOODS, 19_800, Tier.D, CEDA, None, Tier.D),
    # The rest of the book.
    _figure(Category.C2_CAPITAL_GOODS, 8_000, Tier.D, CEDA, None, Tier.D),
    _figure(Category.C3_FUEL_ENERGY, 12_000, Tier.C, DESNZ, None, Tier.C),
    _figure(Category.C4_UPSTREAM_TRANSPORT, 9_000, Tier.D, CEDA, "bidfood", Tier.B),
    _figure(Category.C5_WASTE, 6_500, Tier.C, DESNZ, "waste_co", Tier.A),
    _figure(Category.C6_BUSINESS_TRAVEL, 1_100, Tier.C, DESNZ, None, Tier.C),
    _figure(Category.C7_COMMUTING, 3_400, Tier.E, DESNZ, None, Tier.C),
    _figure(Category.C13_DOWNSTREAM_LEASED, 4_200, Tier.E, DESNZ, "charging", Tier.A),
]

TOTAL_SCOPE_3 = sum(f.tco2e for f in FIGURES)


def uplift_by_counterparty() -> dict[str, float]:
    """Tonnes of tier improvement available per counterparty, derived.

    Computed from FIGURES through the real engine rather than transcribed, so
    a regression in :func:`engines.quality.uplift_tonnes` shows up in the
    scoring tests instead of hiding behind a stale constant. Every known
    counterparty appears, including those with nothing to gain.
    """
    uplift: dict[str, float] = {cid: 0.0 for cid in COUNTERPARTIES}
    for figure in FIGURES:
        if figure.counterparty_id:
            uplift[figure.counterparty_id] = (
                uplift.get(figure.counterparty_id, 0.0) + uplift_tonnes(figure)
            )
    return uplift


#: Categories inside the proposed near-term target boundary. Fuel sold plus
#: the food book carries the coverage test comfortably.
COVERED = frozenset(
    {
        Category.C11_USE_OF_SOLD,
        Category.C1_PURCHASED_GOODS,
        Category.C5_WASTE,
    }
)


# --------------------------------------------------------------------------
# Documents
# --------------------------------------------------------------------------

ISO_CERT_EXPIRED = Document(
    id="doc_iso_bidfood",
    counterparty_id="bidfood",
    doc_type=DocumentType.ISO_CERTIFICATE,
    issue_date=date(2023, 5, 1),
    valid_to=date(2026, 5, 1),
    owner_org_id=ORG,
)

ISO_CERT_EXPIRING = Document(
    id="doc_iso_waste",
    counterparty_id="waste_co",
    doc_type=DocumentType.ISO_CERTIFICATE,
    issue_date=date(2023, 11, 1),
    valid_to=date(2026, 11, 1),
    owner_org_id=ORG,
)

# A published report: open to anyone, and the reason enrichment raises the
# primary-data share even when a counterparty never replies.
REPORT_CURRENT = Document(
    id="doc_report_dairy",
    counterparty_id="dairy_co",
    doc_type=DocumentType.SUSTAINABILITY_REPORT,
    issue_date=date(2026, 4, 1),
    period_covered=2025,
    confidentiality=Confidentiality.PUBLIC,
    owner_org_id=ORG,
)

REPORT_STALE = Document(
    id="doc_report_starbucks",
    counterparty_id="starbucks",
    doc_type=DocumentType.SUSTAINABILITY_REPORT,
    issue_date=date(2025, 1, 15),
    period_covered=2024,
    confidentiality=Confidentiality.PUBLIC,
    owner_org_id=ORG,
)

UTILITY_BILL_STALE = Document(
    id="doc_bill_charging",
    counterparty_id="charging",
    doc_type=DocumentType.UTILITY_BILL,
    issue_date=date(2026, 1, 31),
    owner_org_id=ORG,
)

INVOICE = Document(
    id="doc_invoice_bakery",
    counterparty_id="bakery",
    doc_type=DocumentType.INVOICE,
    issue_date=date(2024, 2, 2),
    owner_org_id=ORG,
)

# Commercially sensitive, held under an agreement with this client only.
PCF_UNDER_NDA = Document(
    id="doc_pcf_beef",
    counterparty_id="beef_co",
    doc_type=DocumentType.EPD,
    issue_date=date(2026, 3, 1),
    valid_to=date(2031, 3, 1),
    confidentiality=Confidentiality.NDA,
    owner_org_id=ORG,
)

# The supplier has consented to one other client of the consultancy seeing it.
VSME_CONSENTED = Document(
    id="doc_vsme_bakery",
    counterparty_id="bakery",
    doc_type=DocumentType.VSME_RETURN,
    issue_date=date(2026, 6, 1),
    period_covered=2025,
    confidentiality=Confidentiality.CONSENTED_REUSE,
    owner_org_id=ORG,
    consented_org_ids=frozenset({OTHER_ORG}),
)

# Extraction ran before anyone attributed it to a client. Fails closed.
UNATTRIBUTED = Document(
    id="doc_orphan",
    counterparty_id="bidfood",
    doc_type=DocumentType.INVOICE,
    issue_date=date(2026, 7, 1),
    confidentiality=Confidentiality.CLIENT_ONLY,
)

#: The documents the validity engine walks. Kept to the set whose ageing is
#: under test, so adding a disclosure fixture does not change a lapse count.
DOCUMENTS: list[Document] = [
    ISO_CERT_EXPIRED,
    ISO_CERT_EXPIRING,
    REPORT_CURRENT,
    REPORT_STALE,
    UTILITY_BILL_STALE,
    INVOICE,
]

#: Every basis, for the disclosure rules.
DISCLOSURE_DOCUMENTS: list[Document] = [
    REPORT_CURRENT,
    INVOICE,
    PCF_UNDER_NDA,
    VSME_CONSENTED,
    UNATTRIBUTED,
]
