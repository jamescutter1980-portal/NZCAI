"""Conflict detection across everything a counterparty has told us.

Runs whenever a document or response lands. Each detector returns a queue item
carrying both values, where each came from, and a proposed resolution with its
reasoning. A human decides; the decision is recorded and reused. Nothing here
silently overwrites a figure.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 7.3.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Sequence

__all__ = [
    "ConflictClass",
    "Conflict",
    "MATERIALITY_TOLERANCE",
    "reported_vs_published",
    "overallocation",
    "allocation_basis_changed",
    "unit_mismatch",
    "unevidenced_renewable_claim",
    "certificate_scope_gap",
    "restatement_without_note",
    "collect",
]


class ConflictClass(str, Enum):
    REPORTED_VS_PUBLISHED = "reported_vs_published"
    OVERALLOCATION = "overallocation"
    ALLOCATION_BASIS_CHANGED = "allocation_basis_changed"
    UNIT_MISMATCH = "unit_mismatch"
    UNEVIDENCED_RENEWABLE_CLAIM = "unevidenced_renewable_claim"
    CERTIFICATE_SCOPE_GAP = "certificate_scope_gap"
    RESTATEMENT_WITHOUT_NOTE = "restatement_without_note"


#: Relative difference below which two figures are treated as the same number
#: rounded differently, rather than a disagreement worth a person's time.
MATERIALITY_TOLERANCE = 0.05


@dataclass(frozen=True)
class Conflict:
    """One disagreement, with enough context for a human to settle it."""

    conflict_class: ConflictClass
    subject: str
    value_a: str
    source_a: str
    value_b: str
    source_b: str
    proposed_resolution: str
    rationale: str


def _relative_difference(a: float, b: float) -> float:
    largest = max(abs(a), abs(b))
    if largest == 0:
        return 0.0
    return abs(a - b) / largest


def reported_vs_published(
    subject: str,
    reported: float,
    published: float,
    *,
    reported_source: str,
    published_source: str,
    tolerance: float = MATERIALITY_TOLERANCE,
) -> Optional[Conflict]:
    """A questionnaire answer that disagrees with the counterparty's own report.

    The published figure is proposed because it has usually been through the
    counterparty's own assurance, whereas a questionnaire is often filled in by
    whoever had the inbox that week.
    """
    if _relative_difference(reported, published) <= tolerance:
        return None
    return Conflict(
        conflict_class=ConflictClass.REPORTED_VS_PUBLISHED,
        subject=subject,
        value_a=f"{reported:,.2f}",
        source_a=reported_source,
        value_b=f"{published:,.2f}",
        source_b=published_source,
        proposed_resolution="Use the published figure",
        rationale=(
            "The published figure sits in a report that has usually been "
            "assured, and differs from what we were sent by "
            f"{_relative_difference(reported, published):.0%}. Ask which is "
            "correct before either is used."
        ),
    )


def overallocation(
    counterparty_name: str,
    allocated_to_customers: float,
    counterparty_total: float,
    *,
    tolerance: float = MATERIALITY_TOLERANCE,
) -> Optional[Conflict]:
    """More emissions allocated across customers than the counterparty reports.

    Physically impossible, so at least one allocation basis is wrong. Common
    where a supplier allocates by revenue share to some customers and by volume
    to others.
    """
    if counterparty_total <= 0:
        return None
    if allocated_to_customers <= counterparty_total * (1 + tolerance):
        return None
    return Conflict(
        conflict_class=ConflictClass.OVERALLOCATION,
        subject=f"{counterparty_name} customer allocation",
        value_a=f"{allocated_to_customers:,.2f}",
        source_a="Sum allocated across customers",
        value_b=f"{counterparty_total:,.2f}",
        source_b="Counterparty reported total",
        proposed_resolution="Re-derive our share on a single stated basis",
        rationale=(
            "Allocated emissions exceed the counterparty's own total, so the "
            "allocation cannot be right. Agree one basis, spend or volume, and "
            "apply it consistently."
        ),
    )


def allocation_basis_changed(
    counterparty_name: str,
    prior_basis: str,
    current_basis: str,
    *,
    explanation: Optional[str] = None,
) -> Optional[Conflict]:
    """A basis that moved between periods without a reason recorded.

    Not wrong in itself, but it breaks year-on-year comparability, and a
    restatement note is needed before the change reaches a disclosure.
    """
    if prior_basis == current_basis or explanation:
        return None
    return Conflict(
        conflict_class=ConflictClass.ALLOCATION_BASIS_CHANGED,
        subject=f"{counterparty_name} allocation basis",
        value_a=prior_basis,
        source_a="Prior period",
        value_b=current_basis,
        source_b="Current period",
        proposed_resolution="Request the reason and restate the prior period",
        rationale=(
            "The basis changed with nothing on file explaining why, so the two "
            "periods are not comparable as they stand."
        ),
    )


def unit_mismatch(
    product: str, declared_unit: str, purchase_unit: str
) -> Optional[Conflict]:
    """A product footprint whose declared unit will not reconcile with ours.

    A footprint per litre against a purchase ledger in kilograms needs a
    density, and guessing one is how an inventory acquires an error nobody can
    later trace.
    """
    if declared_unit == purchase_unit:
        return None
    return Conflict(
        conflict_class=ConflictClass.UNIT_MISMATCH,
        subject=product,
        value_a=declared_unit,
        source_a="Declared unit on the footprint",
        value_b=purchase_unit,
        source_b="Our purchase unit",
        proposed_resolution="Obtain a documented conversion before use",
        rationale=(
            "The units differ, so the footprint cannot be applied to our "
            "quantities without a conversion factor that is itself evidenced."
        ),
    )


def unevidenced_renewable_claim(
    counterparty_name: str, claims_renewable: bool, has_certificate: bool
) -> Optional[Conflict]:
    """A zero-carbon electricity claim with no certificate behind it.

    A market-based Scope 2 figure of zero needs an instrument. Without one the
    location-based figure stands.
    """
    if not claims_renewable or has_certificate:
        return None
    return Conflict(
        conflict_class=ConflictClass.UNEVIDENCED_RENEWABLE_CLAIM,
        subject=f"{counterparty_name} electricity",
        value_a="100% renewable claimed",
        source_a="Counterparty response",
        value_b="No certificate on file",
        source_b="Document store",
        proposed_resolution="Use the location-based factor until evidence arrives",
        rationale=(
            "A market-based claim needs a cancelled certificate behind it. "
            "Request the certificate; until it is on file the claim cannot "
            "reduce the reported figure."
        ),
    )


def certificate_scope_gap(
    counterparty_name: str,
    certified_sites: Sequence[str],
    supplying_sites: Sequence[str],
) -> Optional[Conflict]:
    """A certificate that does not cover the sites we actually buy from.

    The commonest quiet failure in supplier evidence: a valid certificate for
    the wrong factory.
    """
    certified = set(certified_sites)
    uncovered = sorted(set(supplying_sites) - certified)
    if not uncovered:
        return None
    return Conflict(
        conflict_class=ConflictClass.CERTIFICATE_SCOPE_GAP,
        subject=f"{counterparty_name} certificate scope",
        value_a=", ".join(sorted(certified)) or "none",
        source_a="Certificate scope",
        value_b=", ".join(uncovered),
        source_b="Sites supplying us",
        proposed_resolution="Treat the uncovered sites as uncertified",
        rationale=(
            f"{len(uncovered)} site(s) we buy from sit outside the certificate's "
            "scope, so the certificate cannot support a claim about them."
        ),
    )


def restatement_without_note(
    subject: str,
    prior_value: float,
    restated_value: float,
    *,
    has_note: bool,
    tolerance: float = MATERIALITY_TOLERANCE,
) -> Optional[Conflict]:
    """A prior-year figure that moved with no restatement note."""
    if has_note:
        return None
    if _relative_difference(prior_value, restated_value) <= tolerance:
        return None
    return Conflict(
        conflict_class=ConflictClass.RESTATEMENT_WITHOUT_NOTE,
        subject=subject,
        value_a=f"{prior_value:,.2f}",
        source_a="As previously reported",
        value_b=f"{restated_value:,.2f}",
        source_b="As now stated",
        proposed_resolution="Request a restatement note before adopting",
        rationale=(
            "A prior-year figure has moved materially with nothing explaining "
            "the change, which an assurance provider will raise."
        ),
    )


def collect(*candidates: Optional[Conflict]) -> list[Conflict]:
    """Drop the detectors that found nothing, keeping the order they ran in."""
    return [c for c in candidates if c is not None]
