"""Utility bill text -> BillExtract -> ActivityLine.

Reads the text of an electricity or gas bill. PDF-to-text is injected as a
callable so the parser is testable on plain text and deployable with
whatever extractor the host has. Everything found is reported with the
snippet it was found in, so a reviewer can see why the number was read
the way it was rather than trusting a regex.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 7.3,
and docs/spine/BRIEF.md section 6 on source tier A (measured).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Callable, Optional

from engines.activity import ActivityLine
from engines.types import Category

from .common import IngestError, IngestResult, parse_date

__all__ = ["BillExtract", "parse_bill_text", "parse_bill", "TextExtractor"]

TextExtractor = Callable[[bytes], str]

_DATE = r"(\d{1,2}[/ .-](?:\d{1,2}|[A-Za-z]{3,9})[/ .-]\d{2,4}|\d{4}-\d{2}-\d{2})"
_NUM = r"(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)"

_KWH_PATTERNS = (
    re.compile(rf"(?:total\s+)?(?:consumption|usage|units?\s+used|energy\s+used|kwh\s+used)[^\d\n]{{0,40}}{_NUM}\s*kwh", re.I),
    re.compile(rf"{_NUM}\s*kwh\s*(?:used|consumed|total)", re.I),
    re.compile(rf"(?:consumption|usage)[^\n]{{0,40}}?{_NUM}\s*(?:kwh)?", re.I),
)
_PERIOD_PATTERNS = (
    re.compile(rf"(?:period|from|billing period|supply period)[:\s]*{_DATE}\s*(?:to|-|–)\s*{_DATE}", re.I),
    re.compile(rf"{_DATE}\s*(?:to|-|–)\s*{_DATE}", re.I),
)
_MPAN = re.compile(r"(?:mpan|supply number)[^\d]{0,20}(\d{13}|\d{21}|(?:\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{4}\s?\d{4}\s?\d{3}))", re.I)
_MPRN = re.compile(r"(?:mprn|meter point reference)[^\d]{0,20}(\d{6,10})", re.I)
_TOTAL = re.compile(rf"(?:total\s+(?:amount\s+)?(?:due|payable|charges?)|amount\s+due)[^\d£\n]{{0,30}}£?\s*{_NUM}", re.I)
_SUPPLIERS = ("edf", "octopus", "british gas", "eon", "e.on", "sse", "scottishpower", "scottish power",
              "npower", "total energies", "totalenergies", "drax", "opus energy", "smartestenergy", "engie", "corona energy")


@dataclass(frozen=True)
class BillExtract:
    """What was read off the bill, with the text each value came from."""

    fuel: str                       # "electricity" or "gas"
    kwh: Optional[float]
    period_start: Optional[date]
    period_end: Optional[date]
    meter_ref: Optional[str] = None
    supplier: Optional[str] = None
    total_gbp: Optional[float] = None
    snippets: dict[str, str] = field(default_factory=dict)

    @property
    def days(self) -> Optional[int]:
        if self.period_start and self.period_end:
            return (self.period_end - self.period_start).days + 1
        return None

    @property
    def usable(self) -> bool:
        return self.kwh is not None and self.period_end is not None

    def to_activity_line(self, *, factor_key: str, entity_id: str, document_id: str,
                         counterparty_id: Optional[str] = None,
                         category: Optional[Category] = None) -> ActivityLine:
        if self.kwh is None:
            raise ValueError("no consumption was read from the bill")
        return ActivityLine(
            factor_key=factor_key, quantity=self.kwh, unit="kWh", entity_id=entity_id,
            counterparty_id=counterparty_id, document_id=document_id, category=category,
            note=f"bill {self.period_start} to {self.period_end}, meter {self.meter_ref or 'n/a'}",
        )


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def parse_bill_text(text: str, *, source: Optional[str] = None) -> IngestResult[BillExtract]:
    result: IngestResult[BillExtract] = IngestResult(source=source)
    where = source or "bill"
    lower = text.lower()
    fuel = "gas" if (_MPRN.search(text) or re.search(r"\bgas\b", lower)) and not _MPAN.search(text) else "electricity"
    snippets: dict[str, str] = {}

    kwh: Optional[float] = None
    for p in _KWH_PATTERNS:
        m = p.search(text)
        if m:
            kwh = _num(m.group(1))
            snippets["kwh"] = m.group(0).strip()
            break
    if kwh is None:
        result.errors.append(IngestError(where, "no kWh consumption found"))

    start = end = None
    for p in _PERIOD_PATTERNS:
        m = p.search(text)
        if m:
            try:
                start, end = parse_date(m.group(1), "period start"), parse_date(m.group(2), "period end")
                snippets["period"] = m.group(0).strip()
                break
            except ValueError:
                continue
    if end is None:
        result.errors.append(IngestError(where, "no supply period found"))
    elif start and end < start:
        result.errors.append(IngestError(where, f"supply period ends before it starts: {start} to {end}"))
        start = end = None

    meter = None
    m = _MPAN.search(text) or _MPRN.search(text)
    if m:
        meter = re.sub(r"\s", "", m.group(1))
        snippets["meter"] = m.group(0).strip()
    supplier = next((s for s in _SUPPLIERS if s in lower), None)
    total = None
    m = _TOTAL.search(text)
    if m:
        total = _num(m.group(1))
        snippets["total"] = m.group(0).strip()

    result.items.append(BillExtract(fuel=fuel, kwh=kwh, period_start=start, period_end=end, meter_ref=meter,
                                    supplier=supplier, total_gbp=total, snippets=snippets))
    return result


def parse_bill(raw: bytes, *, extract_text: TextExtractor, source: Optional[str] = None) -> IngestResult[BillExtract]:
    """For a PDF or image: run the injected extractor, then read the text."""
    try:
        text = extract_text(raw)
    except Exception as e:  # noqa: BLE001 - the extractor is foreign code
        r: IngestResult[BillExtract] = IngestResult(source=source)
        r.errors.append(IngestError(source or "bill", f"text extraction failed: {e}"))
        return r
    return parse_bill_text(text, source=source)
