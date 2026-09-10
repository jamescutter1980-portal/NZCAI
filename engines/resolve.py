"""Resolving a name on a ledger line to a legal entity.

Purchase ledgers spell the same supplier five ways. The counterparty graph
needs one node per legal entity, with its group parent, so a request goes to
the level that can answer and a franchisor is engaged once for every brand
it owns. Matching here is deterministic: a company number is conclusive, a
normalised exact name is strong, a partial match is a proposal for a person
to confirm, and anything weaker is left unresolved rather than guessed.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 14, resolve.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Mapping, Optional, Sequence

__all__ = ["Candidate", "Resolution", "normalise", "resolve", "resolve_many", "group_root"]


#: Legal-form suffixes and filler words that carry no identity.
_STRIP_WORDS = frozenset(
    {
        "ltd", "limited", "plc", "llp", "lp", "inc", "incorporated", "corp",
        "corporation", "co", "company", "gmbh", "sa", "ag", "bv", "nv",
        "group", "holdings", "holding", "the", "and", "&", "of", "uk", "gb",
    }
)

_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")
_SPACES = re.compile(r"\s+")

#: Shortest normalised name a partial match will be attempted on. Below this
#: "bp" would match "bp pension trustees" and every other two-letter string.
_MIN_PARTIAL_LENGTH = 6


@dataclass(frozen=True)
class Candidate:
    """A known legal entity to match against."""

    id: str
    name: str
    company_number: Optional[str] = None
    parent_id: Optional[str] = None


@dataclass(frozen=True)
class Resolution:
    raw_name: str
    candidate: Optional[Candidate]
    confidence: float
    method: str

    @property
    def resolved(self) -> bool:
        return self.candidate is not None and not self.needs_review

    @property
    def needs_review(self) -> bool:
        """A proposal a person must confirm, or no match at all."""
        return self.confidence < 0.9


def normalise(name: str) -> str:
    """Reduce a name to the words that identify it."""
    lowered = _NON_ALNUM.sub(" ", name.lower().replace("&", " and "))
    words = [w for w in _SPACES.split(lowered) if w and w not in _STRIP_WORDS]
    return " ".join(words)


def resolve(
    raw_name: str,
    candidates: Sequence[Candidate],
    *,
    company_number: Optional[str] = None,
) -> Resolution:
    """Match one ledger name to a candidate, or say that it could not be.

    Precedence: company number, then exact normalised name, then a one-way
    containment on names long enough for that to mean something.
    """
    if company_number:
        number = company_number.strip().upper().lstrip("0")
        for c in candidates:
            if c.company_number and c.company_number.strip().upper().lstrip("0") == number:
                return Resolution(raw_name, c, 1.0, "company_number")

    target = normalise(raw_name)
    if not target:
        return Resolution(raw_name, None, 0.0, "empty after normalisation")

    exact = [c for c in candidates if normalise(c.name) == target]
    if len(exact) == 1:
        return Resolution(raw_name, exact[0], 0.9, "normalised_name")
    if len(exact) > 1:
        return Resolution(
            raw_name, None, 0.0, f"ambiguous: {len(exact)} candidates share this name"
        )

    if len(target) >= _MIN_PARTIAL_LENGTH:
        partial = [
            c
            for c in candidates
            if (n := normalise(c.name))
            and len(n) >= _MIN_PARTIAL_LENGTH
            and (target in n or n in target)
        ]
        if len(partial) == 1:
            return Resolution(raw_name, partial[0], 0.6, "partial_name")
        if len(partial) > 1:
            return Resolution(
                raw_name, None, 0.0, f"ambiguous: {len(partial)} partial matches"
            )

    return Resolution(raw_name, None, 0.0, "no match")


def resolve_many(
    names: Iterable[tuple[str, Optional[str]]], candidates: Sequence[Candidate]
) -> list[Resolution]:
    """Resolve (raw_name, company_number) pairs in order."""
    return [resolve(n, candidates, company_number=num) for n, num in names]


def group_root(candidate: Candidate, by_id: Mapping[str, Candidate]) -> Candidate:
    """Walk parent links to the top of the group. A cycle is a data error."""
    seen = {candidate.id}
    current = candidate
    while current.parent_id is not None:
        if current.parent_id in seen:
            raise ValueError(f"parent cycle at {current.parent_id!r}")
        parent = by_id.get(current.parent_id)
        if parent is None:
            # A dangling parent link is not fatal: the entity is its own root
            # until the parent record arrives.
            break
        seen.add(parent.id)
        current = parent
    return current
