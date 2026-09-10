"""PACT ProductFootprint JSON -> ProductFootprint + Document.

Reads the Pathfinder / PACT Technical Specifications data model, versions
2.x and 3.x. The two differ in field names inside `pcf` and in where the
validity period lives; both are accepted and the spec version is kept on
the footprint's version string so the method label says which.

Nothing is calculated. The kgCO2e per declared unit is taken as the
supplier states it, and whether it is fit to use is the partner engine's
call, not this parser's.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 6.3.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Optional

from engines.partner import ProductFootprint
from engines.types import Confidentiality, Document, DocumentType

from .common import IngestError, IngestResult, document_for_bytes

__all__ = ["PactFootprint", "parse_pact", "DECLARED_UNITS"]

#: PACT declared units -> the unit strings the factor library uses.
DECLARED_UNITS: dict[str, str] = {
    "liter": "litre", "litre": "litre",
    "kilogram": "kg",
    "cubic meter": "m3", "cubic metre": "m3",
    "kilowatt hour": "kWh",
    "megajoule": "MJ",
    "ton kilometer": "tkm", "tonne kilometre": "tkm",
    "square meter": "m2", "square metre": "m2",
    "piece": "piece",
    "hour": "hour",
    "megabit second": "Mbps",
}


@dataclass(frozen=True)
class PactFootprint:
    """The parsed payload: what the partner engine needs plus the document
    record that evidences it."""

    footprint: ProductFootprint
    document: Document
    spec_version: str
    status: str
    reference_period: tuple[Optional[date], Optional[date]]
    assurance_coverage: Optional[str]
    biogenic_included: bool


def _date(raw: Any) -> Optional[date]:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _first(d: dict, *keys: str) -> Any:
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None


def parse_pact(
    raw: bytes | str,
    *,
    counterparty_id: str,
    owner_org_id: str,
    doc_id: Optional[str] = None,
    confidentiality: Confidentiality = Confidentiality.CLIENT_ONLY,
    include_biogenic: bool = False,
) -> IngestResult[PactFootprint]:
    """Parse one ProductFootprint object, or a `{"data": [...]}` listing."""
    data = raw.encode() if isinstance(raw, str) else raw
    result: IngestResult[PactFootprint] = IngestResult(source="pact")
    try:
        body = json.loads(data)
    except json.JSONDecodeError as e:
        result.errors.append(IngestError("pact", f"not JSON: {e.msg}"))
        return result
    objects = body["data"] if isinstance(body, dict) and isinstance(body.get("data"), list) else [body]
    for i, obj in enumerate(objects):
        where = f"pact[{i}]"
        try:
            if not isinstance(obj, dict) or "pcf" not in obj:
                raise ValueError("no pcf block")
            pcf = obj["pcf"]
            spec = str(_first(obj, "specVersion") or "unknown")
            unit_raw = _first(pcf, "declaredUnitOfMeasurement", "declaredUnit")
            if not unit_raw:
                raise ValueError("no declared unit")
            unit = DECLARED_UNITS.get(str(unit_raw).strip().lower())
            if unit is None:
                raise ValueError(f"unrecognised declared unit {unit_raw!r}")
            key_field = ("pcfIncludingBiogenic", "pCfIncludingBiogenic") if include_biogenic \
                else ("pcfExcludingBiogenic", "pCfExcludingBiogenic")
            per_unit_raw = _first(pcf, *key_field)
            if per_unit_raw is None:
                raise ValueError(f"no {key_field[0]}")
            per_unit = float(per_unit_raw)
            amount = float(_first(pcf, "declaredUnitAmount", "unitaryProductAmount") or 1.0)
            if amount <= 0:
                raise ValueError("declared unit amount must be positive")
            per_unit = per_unit / amount
            product_ids = obj.get("productIds") or []
            item_key = str(product_ids[0]) if product_ids else str(_first(obj, "productNameCompany", "id") or "")
            if not item_key:
                raise ValueError("no product identifier")
            status = str(obj.get("status") or "Active")
            if status.lower() == "deprecated":
                raise ValueError("footprint is deprecated by its owner")
            created = _date(obj.get("created")) or date.today()
            validity_end = _date(_first(obj, "validityPeriodEnd") or pcf.get("validityPeriodEnd"))
            ref_start = _date(pcf.get("referencePeriodStart"))
            ref_end = _date(pcf.get("referencePeriodEnd"))
            assurance = _first(pcf, "verification", "assurance") or {}
            coverage = assurance.get("coverage") if isinstance(assurance, dict) else None
            verified = bool(coverage)
            version = f"PACT {spec} v{obj.get('version', 0)}"
            document = document_for_bytes(
                data, doc_id=doc_id or f"pact:{obj.get('id') or item_key}",
                counterparty_id=counterparty_id, doc_type=DocumentType.PACT_PAYLOAD,
                issue_date=created, owner_org_id=owner_org_id,
                confidentiality=confidentiality,
                period_covered=ref_end.year if ref_end else None, valid_to=validity_end,
            )
            footprint = ProductFootprint(
                counterparty_id=counterparty_id,
                counterparty_name=str(obj.get("companyName") or counterparty_id),
                item_key=item_key, kgco2e_per_unit=per_unit, unit=unit, version=version,
                document_id=document.id, verified=verified, origin="PACT payload",
            )
            result.items.append(PactFootprint(
                footprint=footprint, document=document, spec_version=spec, status=status,
                reference_period=(ref_start, ref_end), assurance_coverage=coverage,
                biogenic_included=include_biogenic,
            ))
        except (ValueError, TypeError, KeyError) as e:
            result.errors.append(IngestError(where, str(e)))
    return result
