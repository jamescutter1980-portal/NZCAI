"""Purchase-ledger CSV -> LedgerLine.

Accepts the column names finance exports actually use rather than a fixed
template. A row without an amount or a supplier is reported, not dropped
silently, because a missing supplier is exactly the row that hides a
counterparty.
"""

from __future__ import annotations

from typing import Optional

from engines.spend_map import LedgerLine

from .common import IngestError, IngestResult, parse_date, parse_float, parse_int, pick, read_csv_rows

__all__ = ["parse_ledger_csv"]

_ID = ("id", "line_id", "transaction_id", "ref", "reference", "doc_no", "document_number")
_GL = ("gl_code", "gl", "nominal_code", "nominal", "account_code", "account", "code")
_DESC = ("description", "narrative", "details", "memo", "line_description")
_SUPPLIER = ("supplier_name", "supplier", "vendor", "vendor_name", "payee", "counterparty", "name")
_AMOUNT = ("amount_gbp", "amount", "net", "net_amount", "value", "total", "gross")
_YEAR = ("spend_year", "year", "fy", "financial_year", "period")
_DATE = ("date", "posting_date", "invoice_date", "transaction_date")
_CP = ("counterparty_id", "supplier_id", "vendor_id", "supplier_code", "vendor_code")


def parse_ledger_csv(text: str, *, source: Optional[str] = None,
                     default_year: Optional[int] = None) -> IngestResult[LedgerLine]:
    """Parse a ledger export. Negative amounts (credits, reversals) are kept as
    zero-spend lines with the original amount in the description, so the
    ledger total reconciles while the emissions engine sees no negative spend."""
    result: IngestResult[LedgerLine] = IngestResult(source=source)
    seen: set[str] = set()
    for n, row in read_csv_rows(text):
        where = f"{source or 'ledger'} line {n}"
        try:
            supplier = pick(row, *_SUPPLIER)
            if not supplier:
                raise ValueError("no supplier name")
            amount_raw = pick(row, *_AMOUNT)
            if amount_raw is None:
                raise ValueError("no amount")
            amount = parse_float(amount_raw, "amount")
            year_raw = pick(row, *_YEAR)
            if year_raw and len(year_raw) == 4:
                year = parse_int(year_raw, "year")
            else:
                date_raw = pick(row, *_DATE)
                if date_raw:
                    year = parse_date(date_raw, "date").year
                elif default_year is not None:
                    year = default_year
                else:
                    raise ValueError("no year or date, and no default year given")
            line_id = pick(row, *_ID) or f"{source or 'ledger'}:{n}"
            if line_id in seen:
                raise ValueError(f"duplicate line id {line_id!r}")
            seen.add(line_id)
            description = pick(row, *_DESC) or ""
            if amount < 0:
                description = f"{description} [credit {amount:,.2f}]".strip()
                amount = 0.0
            result.items.append(LedgerLine(
                id=line_id, gl_code=pick(row, *_GL) or "", description=description,
                supplier_name=supplier, amount_gbp=amount, spend_year=year,
                counterparty_id=pick(row, *_CP),
            ))
        except ValueError as e:
            result.errors.append(IngestError(where, str(e)))
    return result
