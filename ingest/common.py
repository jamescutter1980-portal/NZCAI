"""Shared shapes for the parsers."""

from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Generic, Iterator, Optional, TypeVar

from engines.types import Confidentiality, Document, DocumentType

T = TypeVar("T")

__all__ = [
    "IngestError", "IngestResult", "document_for_bytes", "read_csv_rows",
    "pick", "parse_date", "parse_float", "parse_int",
]


@dataclass(frozen=True)
class IngestError:
    """One row or field that could not be read, with where it was."""

    where: str
    message: str

    def __str__(self) -> str:
        return f"{self.where}: {self.message}"


@dataclass
class IngestResult(Generic[T]):
    """What parsed and what did not. Callers decide whether partial is enough."""

    items: list[T] = field(default_factory=list)
    errors: list[IngestError] = field(default_factory=list)
    source: Optional[str] = None

    @property
    def ok(self) -> bool:
        return not self.errors

    def raise_if_errors(self) -> None:
        if self.errors:
            raise ValueError("; ".join(str(e) for e in self.errors))


def document_for_bytes(
    raw: bytes,
    *,
    doc_id: str,
    counterparty_id: str,
    doc_type: DocumentType,
    issue_date: date,
    owner_org_id: str,
    confidentiality: Confidentiality = Confidentiality.CLIENT_ONLY,
    period_covered: Optional[int] = None,
    valid_to: Optional[date] = None,
) -> Document:
    """A Document record for received bytes. The hash is what later proves the
    file on disk is the file the figure was built from."""
    return Document(
        id=doc_id, counterparty_id=counterparty_id, doc_type=doc_type,
        issue_date=issue_date, confidentiality=confidentiality,
        period_covered=period_covered, valid_to=valid_to,
        owner_org_id=owner_org_id, sha256=hashlib.sha256(raw).hexdigest(),
    )


# --- small field readers, shared by the CSV parsers ---------------------------

def read_csv_rows(text: str) -> Iterator[tuple[int, dict[str, str]]]:
    """Yield (line_number, row) with header names lower-cased and stripped."""
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        return
    reader.fieldnames = [re.sub(r"[\s\-]+", "_", (h or "").strip().lower()) for h in reader.fieldnames]
    for row in reader:
        yield reader.line_num, {k: (v or "").strip() for k, v in row.items() if k is not None}


def pick(row: dict[str, str], *names: str) -> Optional[str]:
    """First non-empty value among alias column names."""
    for n in names:
        v = row.get(n)
        if v:
            return v
    return None


def parse_float(raw: str, what: str) -> float:
    cleaned = raw.replace(",", "").replace("£", "").replace("$", "").replace("€", "").strip()
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]
    try:
        return float(cleaned)
    except ValueError:
        raise ValueError(f"{what} is not a number: {raw!r}") from None


def parse_int(raw: str, what: str) -> int:
    try:
        return int(raw.strip())
    except ValueError:
        raise ValueError(f"{what} is not a whole number: {raw!r}") from None


_DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y", "%d %b %Y", "%d %B %Y", "%Y%m%d")


def parse_date(raw: str, what: str) -> date:
    from datetime import datetime
    s = raw.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"{what} is not a date: {raw!r}")
