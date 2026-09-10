"""Document validity and lapse detection.

This is what makes the module self-sustaining. Certificates expire, reports are
annual, and product declarations carry a validity date. Rather than relying on
somebody remembering, an expiring document moves its engagement to LAPSED and
the chase re-opens on its own.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md sections 7.2 and 4.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Iterable, Optional

from .types import Document, DocumentStatus, DocumentType

__all__ = [
    "Lapse",
    "IMPLICIT_VALIDITY_MONTHS",
    "EXPIRY_WARNING_DAYS",
    "status",
    "expires_within",
    "lapsed",
]


#: How long a document of each type stays useful when it carries no explicit
#: expiry date. Annual disclosures get fifteen months so a client is not
#: chased the day after year end for a report nobody has published yet.
IMPLICIT_VALIDITY_MONTHS: dict[DocumentType, Optional[int]] = {
    DocumentType.SUSTAINABILITY_REPORT: 15,
    DocumentType.CDP_RESPONSE: 15,
    DocumentType.SBTI_TARGET: 24,
    DocumentType.EPD: 60,
    DocumentType.PACT_PAYLOAD: 12,
    DocumentType.VSME_RETURN: 15,
    DocumentType.ISO_CERTIFICATE: 36,
    DocumentType.ASSURANCE_STATEMENT: 15,
    DocumentType.WASTE_TRANSFER_NOTE: 15,
    DocumentType.UTILITY_BILL: 3,
    DocumentType.FRANCHISOR_REQUEST: 12,
    # Transactional or open-ended: an invoice does not go out of date, and an
    # agreement runs until its own term says otherwise.
    DocumentType.INVOICE: None,
    DocumentType.AGREEMENT: None,
}

#: A document inside this window of its stated expiry is flagged stale, so the
#: replacement is requested before the evidence actually lapses.
EXPIRY_WARNING_DAYS = 90


@dataclass(frozen=True)
class Lapse:
    """A document that has aged out, and why it needs replacing."""

    document: Document
    status: DocumentStatus
    reason: str


def _months_between(earlier: date, later: date) -> int:
    """Whole months elapsed, counting a partial month only once complete."""
    months = (later.year - earlier.year) * 12 + (later.month - earlier.month)
    if later.day < earlier.day:
        months -= 1
    return months


def status(document: Document, today: date) -> DocumentStatus:
    """Whether a document is current, ageing, or no longer valid.

    A stated expiry wins over the implicit rule for its type, because a
    certificate that says when it runs out is more authoritative than any
    default we choose.
    """
    if document.valid_to is not None:
        if today > document.valid_to:
            return DocumentStatus.EXPIRED
        if (document.valid_to - today).days <= EXPIRY_WARNING_DAYS:
            return DocumentStatus.STALE
        return DocumentStatus.CURRENT

    months = IMPLICIT_VALIDITY_MONTHS.get(document.doc_type)
    if months is None:
        return DocumentStatus.CURRENT
    if _months_between(document.issue_date, today) >= months:
        return DocumentStatus.STALE
    return DocumentStatus.CURRENT


def expires_within(document: Document, today: date, days: int) -> bool:
    """Whether a stated expiry falls inside the next `days`. False if undated."""
    if document.valid_to is None:
        return False
    delta = (document.valid_to - today).days
    return 0 <= delta <= days


def lapsed(documents: Iterable[Document], today: date) -> list[Lapse]:
    """Documents needing replacement, worst first.

    Expired evidence ranks above merely ageing evidence, and within each group
    the oldest comes first, so the worklist reads top down.
    """
    results: list[Lapse] = []
    for document in documents:
        state = status(document, today)
        if state is DocumentStatus.CURRENT:
            continue
        if state is DocumentStatus.EXPIRED:
            reason = (
                f"Expired on {document.valid_to:%d %b %Y}. Any figure resting on "
                f"it is unevidenced until replaced."
            )
        elif document.valid_to is not None:
            reason = (
                f"Expires on {document.valid_to:%d %b %Y}, inside the "
                f"{EXPIRY_WARNING_DAYS}-day warning window."
            )
        else:
            months = IMPLICIT_VALIDITY_MONTHS[document.doc_type]
            reason = (
                f"Issued {document.issue_date:%d %b %Y}, past the {months}-month "
                f"validity for a {document.doc_type.value.replace('_', ' ')}."
            )
        results.append(Lapse(document=document, status=state, reason=reason))

    return sorted(
        results,
        key=lambda l: (l.status is not DocumentStatus.EXPIRED, l.document.issue_date),
    )
