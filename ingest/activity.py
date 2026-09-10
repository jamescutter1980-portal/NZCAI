"""Activity-data CSV -> ActivityLine.

The template is what a site manager can fill in: what was used, how much,
in what unit, where. The factor key is the join to the factor library and
is validated against it when a library is given, so a typo surfaces at
ingestion rather than as a FactorNotFound three engines later.
"""

from __future__ import annotations

from typing import Optional

from engines.activity import ActivityLine
from engines.factors import FactorLibrary
from engines.types import Category, Tier

from .common import IngestError, IngestResult, parse_float, pick, read_csv_rows

__all__ = ["parse_activity_csv"]

_KEY = ("factor_key", "factor", "activity", "activity_type", "fuel", "key")
_QTY = ("quantity", "qty", "amount", "consumption", "value", "units_used")
_UNIT = ("unit", "uom", "units")
_ENTITY = ("entity_id", "entity", "site", "site_id", "location", "outlet")
_CP = ("counterparty_id", "supplier_id", "supplier", "vendor_id")
_DOC = ("document_id", "document", "evidence", "evidence_id", "bill_id")
_CAT = ("category", "scope3_category", "ghg_category")
_ACH = ("achievable_tier", "achievable")
_NOTE = ("note", "notes", "comment")


def _category(raw: str) -> Category:
    s = raw.strip().lower().removeprefix("category").removeprefix("cat").strip(" .")
    try:
        return Category(s)
    except ValueError:
        raise ValueError(f"unknown category {raw!r}") from None


def parse_activity_csv(text: str, *, source: Optional[str] = None,
                       library: Optional[FactorLibrary] = None) -> IngestResult[ActivityLine]:
    result: IngestResult[ActivityLine] = IngestResult(source=source)
    for n, row in read_csv_rows(text):
        where = f"{source or 'activity'} line {n}"
        try:
            key = pick(row, *_KEY)
            if not key:
                raise ValueError("no factor key")
            key = key.strip().lower()
            if library is not None and key not in library:
                raise ValueError(f"factor {key!r} is not in the library")
            qty_raw = pick(row, *_QTY)
            if qty_raw is None:
                raise ValueError("no quantity")
            unit = pick(row, *_UNIT)
            if not unit:
                raise ValueError("no unit")
            cat_raw = pick(row, *_CAT)
            ach_raw = pick(row, *_ACH)
            result.items.append(ActivityLine(
                factor_key=key, quantity=parse_float(qty_raw, "quantity"), unit=unit,
                entity_id=pick(row, *_ENTITY), counterparty_id=pick(row, *_CP),
                document_id=pick(row, *_DOC),
                category=_category(cat_raw) if cat_raw else None,
                achievable_tier=Tier(ach_raw.strip().upper()) if ach_raw else None,
                note=pick(row, *_NOTE),
            ))
        except ValueError as e:
            result.errors.append(IngestError(where, str(e)))
    return result
