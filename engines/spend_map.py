"""Mapping purchase-ledger lines to emission-factor sectors, deterministically.

Rules, in order: exclusions first, then general-ledger code patterns, then
keyword patterns, then the review queue. A line the rules cannot place is
returned as unmapped with the reason, never guessed. The engagement brief
lets a local model *propose* a mapping for those; the proposal is stored
with a confidence and confirmed by a person before it reaches this engine.

Reference: docs/product/nzc-ai-scope-3-brief.md section 5, spend_map.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from typing import Iterable, Optional, Sequence

from .types import Category

__all__ = [
    "Exclusion",
    "LedgerLine",
    "MappingRule",
    "Mapping",
    "map_line",
    "map_many",
    "DEFAULT_EXCLUSIONS",
]


class Exclusion(str, Enum):
    """Why a ledger line carries no emissions of its own under this method."""

    VAT = "vat"
    INTERCOMPANY = "intercompany"
    PAYROLL = "payroll"
    TAX_AND_DUTY = "tax_and_duty"
    FINANCE_COST = "finance_cost"
    DEPRECIATION = "depreciation"
    #: Not excluded from the inventory, but excluded from *this* method: the
    #: energy is metered and calculated by the activity engine, so counting
    #: the bill as spend would double it.
    METERED_ENERGY = "metered_energy"


@dataclass(frozen=True)
class LedgerLine:
    id: str
    gl_code: str
    description: str
    supplier_name: str
    amount_gbp: float
    spend_year: int
    counterparty_id: Optional[str] = None


@dataclass(frozen=True)
class MappingRule:
    """One rule. Either a GL code pattern or a description keyword pattern.

    Confidence is a statement about the rule, not the line: a GL code the
    finance team assigns deliberately is more reliable than a word in a free
    text description.
    """

    sector_key: str
    category: Category
    confidence: float
    gl_pattern: Optional[str] = None
    keyword_pattern: Optional[str] = None
    label: str = ""

    def matches(self, line: LedgerLine) -> bool:
        if self.gl_pattern and re.fullmatch(self.gl_pattern, line.gl_code):
            return True
        if self.keyword_pattern and re.search(
            self.keyword_pattern, line.description, re.IGNORECASE
        ):
            return True
        return False


@dataclass(frozen=True)
class Mapping:
    """The outcome for one line. Exactly one of sector, exclusion, or neither."""

    line_id: str
    sector_key: Optional[str]
    category: Optional[Category]
    confidence: float
    rule_label: str
    exclusion: Optional[Exclusion] = None

    @property
    def mapped(self) -> bool:
        return self.sector_key is not None

    @property
    def excluded(self) -> bool:
        return self.exclusion is not None

    @property
    def needs_review(self) -> bool:
        return not self.mapped and not self.excluded


@dataclass(frozen=True)
class ExclusionRule:
    exclusion: Exclusion
    gl_pattern: Optional[str] = None
    keyword_pattern: Optional[str] = None

    def matches(self, line: LedgerLine) -> bool:
        if self.gl_pattern and re.fullmatch(self.gl_pattern, line.gl_code):
            return True
        if self.keyword_pattern and re.search(
            self.keyword_pattern, line.description, re.IGNORECASE
        ):
            return True
        return False


#: Sensible defaults for a UK chart of accounts. Callers pass their own; these
#: exist so the engine is usable before a client's ledger has been studied.
DEFAULT_EXCLUSIONS: tuple[ExclusionRule, ...] = (
    ExclusionRule(Exclusion.VAT, keyword_pattern=r"\bVAT\b|value added tax"),
    ExclusionRule(Exclusion.INTERCOMPANY, keyword_pattern=r"inter-?company|intra-?group"),
    ExclusionRule(Exclusion.PAYROLL, keyword_pattern=r"\bsalar|\bwages?\b|\bpayroll\b|\bPAYE\b|national insurance"),
    ExclusionRule(Exclusion.TAX_AND_DUTY, keyword_pattern=r"corporation tax|business rates|\bduty\b|\bexcise\b"),
    ExclusionRule(Exclusion.FINANCE_COST, keyword_pattern=r"\binterest\b|loan (?:fee|repayment)|bank charges"),
    ExclusionRule(Exclusion.DEPRECIATION, keyword_pattern=r"depreciation|amortisation|amortization"),
    ExclusionRule(Exclusion.METERED_ENERGY, keyword_pattern=r"\belectricity\b|\bgas\b(?! oil)|\bkWh\b|\bMPAN\b|\bMPRN\b"),
)


def map_line(
    line: LedgerLine,
    rules: Sequence[MappingRule],
    *,
    exclusions: Sequence[ExclusionRule] = DEFAULT_EXCLUSIONS,
) -> Mapping:
    """Place one ledger line, or say why it cannot be placed."""
    for exclusion in exclusions:
        if exclusion.matches(line):
            return Mapping(
                line_id=line.id,
                sector_key=None,
                category=None,
                confidence=1.0,
                rule_label=f"excluded: {exclusion.exclusion.value}",
                exclusion=exclusion.exclusion,
            )

    # GL code rules are tried before keyword rules regardless of list order,
    # because a deliberate account code beats a word in a description.
    for rule in sorted(rules, key=lambda r: (r.gl_pattern is None, -r.confidence)):
        if rule.matches(line):
            return Mapping(
                line_id=line.id,
                sector_key=rule.sector_key,
                category=rule.category,
                confidence=rule.confidence,
                rule_label=rule.label or rule.sector_key,
            )

    return Mapping(
        line_id=line.id,
        sector_key=None,
        category=None,
        confidence=0.0,
        rule_label="no rule matched; queued for review",
    )


def map_many(
    lines: Iterable[LedgerLine],
    rules: Sequence[MappingRule],
    *,
    exclusions: Sequence[ExclusionRule] = DEFAULT_EXCLUSIONS,
) -> list[Mapping]:
    return [map_line(line, rules, exclusions=exclusions) for line in lines]
