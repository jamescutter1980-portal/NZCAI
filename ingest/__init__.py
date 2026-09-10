"""Ingestion: files and payloads in, engine inputs out.

Each parser turns one external shape into the dataclasses the engines
consume, and nothing more. No parser calculates, and none writes to the
store. A parser returns an :class:`IngestResult` so a bad row is reported
with its position rather than losing the batch around it.

    ledger.py    purchase-ledger CSV        -> engines.spend_map.LedgerLine
    activity.py  activity-data CSV          -> engines.activity.ActivityLine
    pact.py      PACT ProductFootprint JSON -> engines.partner.ProductFootprint + Document
    vsme.py      VSME return (xlsx or xBRL-JSON) -> VsmeReturn -> PartnerResponse
    bill.py      utility bill text          -> BillExtract -> ActivityLine
"""

from .common import IngestError, IngestResult, document_for_bytes

__all__ = ["IngestError", "IngestResult", "document_for_bytes"]
