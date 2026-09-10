"""Whether a document may be shown to a given organisation.

The confidentiality basis on a document is worthless if it is only recorded.
This module is the rule that makes it bite, and it lives in the engine layer
deliberately: a disclosure decision must not be reimplemented in an API
handler, an export routine and a UI guard, because the day those three
disagree is the day a supplier's figures reach a competing buyer.

The rule fails closed. An unattributed document, an unknown basis or a missing
requester all resolve to "no".

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 7.4 and
           hard constraint 4.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from .types import Confidentiality, Document

__all__ = [
    "Decision",
    "may_disclose",
    "disclosable",
    "withheld",
    "assert_disclosable",
]


class DisclosureRefused(PermissionError):
    """Raised by :func:`assert_disclosable` when a document must not be shown."""


@dataclass(frozen=True)
class Decision:
    """A disclosure ruling, with the reason it went the way it did.

    The reason is part of the result rather than a log line, because an
    auditor asking why a figure appears without its evidence needs an answer
    and a reviewer seeing a withheld document needs to know whether to chase
    a consent or an NDA.
    """

    allowed: bool
    basis: Confidentiality
    reason: str

    def __bool__(self) -> bool:
        return self.allowed


def may_disclose(
    document: Document,
    *,
    to_org_id: str | None,
) -> Decision:
    """Decide whether `document` may be shown to `to_org_id`.

    Args:
        document: the artefact in question.
        to_org_id: the organisation asking to see it. None means an
            unauthenticated or unattributed request.

    Returns:
        A Decision that is falsy when disclosure is refused, so it reads
        naturally in a guard while still carrying its reason.
    """
    basis = document.confidentiality

    if basis is Confidentiality.PUBLIC:
        return Decision(
            True, basis, "Published by the counterparty, so open to anyone."
        )

    if to_org_id is None:
        return Decision(
            False,
            basis,
            "No requesting organisation, and the basis is not public.",
        )

    if document.owner_org_id is None:
        return Decision(
            False,
            basis,
            "Document is unattributed to a client, so it is disclosed to "
            "nobody. Attribute it before it can be used as evidence.",
        )

    if document.owner_org_id == to_org_id:
        return Decision(
            True, basis, "The requesting organisation holds this document."
        )

    if basis is Confidentiality.CONSENTED_REUSE:
        if to_org_id in document.consented_org_ids:
            return Decision(
                True,
                basis,
                "The counterparty has consented to this organisation seeing it.",
            )
        return Decision(
            False,
            basis,
            "Consented for reuse, but not to this organisation. Obtain "
            "consent before sharing.",
        )

    if basis is Confidentiality.NDA:
        return Decision(
            False,
            basis,
            "Held under a non-disclosure agreement with another client. That "
            "agreement does not extend here.",
        )

    if basis is Confidentiality.CLIENT_ONLY:
        return Decision(
            False,
            basis,
            "Given to another client for its own reporting.",
        )

    # Unreachable while Confidentiality is exhaustively handled above. Kept so
    # that adding a member without a rule fails closed rather than silently
    # falling through to permitted.
    return Decision(  # pragma: no cover
        False, basis, f"No disclosure rule for basis {basis.value}; refused."
    )


def disclosable(
    documents: Iterable[Document], *, to_org_id: str | None
) -> list[Document]:
    """The subset of `documents` that may be shown, order preserved.

    Use this on every export path. Filtering at the point of export rather
    than at the point of query is what keeps a figure usable in an inventory
    while its underlying document stays out of the pack.
    """
    return [d for d in documents if may_disclose(d, to_org_id=to_org_id).allowed]


def withheld(
    documents: Iterable[Document], *, to_org_id: str | None
) -> list[tuple[Document, Decision]]:
    """What was held back and why, for the reviewer's benefit.

    A silently shorter evidence appendix is worse than a visibly redacted one:
    the reviewer needs to know whether to chase a consent, an NDA or an
    attribution.
    """
    results: list[tuple[Document, Decision]] = []
    for document in documents:
        decision = may_disclose(document, to_org_id=to_org_id)
        if not decision.allowed:
            results.append((document, decision))
    return results


def assert_disclosable(document: Document, *, to_org_id: str | None) -> Document:
    """Return the document, or raise if it must not be shown.

    For the paths where a refusal is a bug rather than a filter, such as
    resolving the evidence behind a figure the caller has already been told
    about.
    """
    decision = may_disclose(document, to_org_id=to_org_id)
    if not decision.allowed:
        raise DisclosureRefused(
            f"document {document.id} not disclosable to "
            f"{to_org_id or 'an unattributed requester'}: {decision.reason}"
        )
    return document
