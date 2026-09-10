"""VSME return -> VsmeReturn -> PartnerResponse.

The EFRAG VSME standard is the ceiling on what a sub-1,000-employee
supplier can be asked for. It arrives two ways: the EFRAG Excel template,
and xBRL-JSON from a supplier's reporting tool. Both are read here into
one shape, and the shape converts to the partner engine's PartnerResponse
once the client's share and allocation basis are known, which the return
itself never says.

The xlsx reader uses the standard library only: an xlsx is a zip of XML.
It finds values by the label in the cell to their left, not by grid
position, because EFRAG has already revised the template's layout once.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 6.2.
"""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date
from io import BytesIO
from typing import Optional
from xml.etree import ElementTree as ET

from engines.partner import AllocationBasis, PartnerResponse
from engines.types import Confidentiality, Document, DocumentType

from .common import IngestError, IngestResult, document_for_bytes

__all__ = ["VsmeReturn", "parse_vsme", "CONCEPTS"]

#: Label patterns (xlsx) and concept names (xBRL) for the fields we need.
#: Concept names follow the EFRAG VSME taxonomy naming; both the prefixed and
#: bare local names are matched so a tool that drops the prefix still reads.
CONCEPTS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "scope1_tco2e": (
        (r"scope\s*1\b",),
        ("GrossScope1GreenhouseGasEmissions", "GrossScope1GHGEmissions", "Scope1GHGEmissions"),
    ),
    "scope2_location_tco2e": (
        (r"scope\s*2.*location",),
        ("GrossLocationBasedScope2GreenhouseGasEmissions", "GrossLocationBasedScope2GHGEmissions"),
    ),
    "scope2_market_tco2e": (
        (r"scope\s*2.*market",),
        ("GrossMarketBasedScope2GreenhouseGasEmissions", "GrossMarketBasedScope2GHGEmissions"),
    ),
    "scope3_tco2e": (
        (r"scope\s*3\b",),
        ("GrossScope3GreenhouseGasEmissions", "GrossScope3GHGEmissions"),
    ),
    "employees": (
        (r"number of employees", r"employees.*head\s*count", r"headcount"),
        ("NumberOfEmployeesHeadCount", "NumberOfEmployees", "AverageNumberOfEmployees"),
    ),
    "turnover": (
        (r"turnover", r"revenue"),
        ("Revenue", "Turnover", "NetTurnover"),
    ),
    "energy_mwh": (
        (r"total energy consumption",),
        ("TotalEnergyConsumption",),
    ),
}


@dataclass(frozen=True)
class VsmeReturn:
    """What a VSME return says. Optional fields are absent from the return,
    not zero; the distinction matters for a supplier that reports Scope 1
    and declines Scope 2."""

    counterparty_id: str
    counterparty_name: str
    period: int
    scope1_tco2e: Optional[float]
    scope2_location_tco2e: Optional[float]
    scope2_market_tco2e: Optional[float]
    scope3_tco2e: Optional[float] = None
    employees: Optional[int] = None
    turnover: Optional[float] = None
    energy_mwh: Optional[float] = None
    document: Optional[Document] = None
    format: str = "xlsx"
    missing: tuple[str, ...] = field(default_factory=tuple)

    @property
    def scope2_tco2e(self) -> Optional[float]:
        """Market-based where given, else location-based. ESRS wants both;
        allocation to a customer uses market-based when the supplier has
        bought specific electricity, which is what the choice reflects."""
        return self.scope2_market_tco2e if self.scope2_market_tco2e is not None else self.scope2_location_tco2e

    @property
    def complete_for_allocation(self) -> bool:
        return self.scope1_tco2e is not None and self.scope2_tco2e is not None

    def to_partner_response(self, *, our_share: float, basis: AllocationBasis,
                            verified: bool = False, include_scope3: bool = False) -> PartnerResponse:
        if not self.complete_for_allocation:
            raise ValueError(f"return is missing {', '.join(self.missing) or 'scope figures'}; cannot allocate")
        return PartnerResponse(
            counterparty_id=self.counterparty_id, counterparty_name=self.counterparty_name,
            period=self.period, scope1_tco2e=self.scope1_tco2e or 0.0,
            scope2_tco2e=self.scope2_tco2e or 0.0, our_share=our_share, basis=basis,
            document_id=self.document.id if self.document else None,
            scope3_upstream_tco2e=self.scope3_tco2e if include_scope3 else None,
            verified=verified,
        )


def parse_vsme(
    raw: bytes,
    *,
    counterparty_id: str,
    counterparty_name: str,
    period: int,
    owner_org_id: str,
    doc_id: Optional[str] = None,
    issue_date: Optional[date] = None,
    confidentiality: Confidentiality = Confidentiality.CLIENT_ONLY,
) -> IngestResult[VsmeReturn]:
    """Sniff the format and read it. One return per file."""
    result: IngestResult[VsmeReturn] = IngestResult(source="vsme")
    try:
        if raw[:2] == b"PK":
            values, fmt = _read_xlsx(raw), "xlsx"
        else:
            values, fmt = _read_xbrl_json(raw), "xbrl-json"
    except ValueError as e:
        result.errors.append(IngestError("vsme", str(e)))
        return result
    document = document_for_bytes(
        raw, doc_id=doc_id or f"vsme:{counterparty_id}:{period}", counterparty_id=counterparty_id,
        doc_type=DocumentType.VSME_RETURN, issue_date=issue_date or date.today(),
        owner_org_id=owner_org_id, confidentiality=confidentiality, period_covered=period,
    )
    missing = tuple(k for k in ("scope1_tco2e", "scope2_location_tco2e", "scope2_market_tco2e") if k not in values)
    for k in ("scope1_tco2e", "scope2_location_tco2e", "scope2_market_tco2e", "scope3_tco2e"):
        if values.get(k, 0) < 0:
            result.errors.append(IngestError("vsme", f"{k} is negative"))
            return result
    employees = values.get("employees")
    result.items.append(VsmeReturn(
        counterparty_id=counterparty_id, counterparty_name=counterparty_name, period=period,
        scope1_tco2e=values.get("scope1_tco2e"),
        scope2_location_tco2e=values.get("scope2_location_tco2e"),
        scope2_market_tco2e=values.get("scope2_market_tco2e"),
        scope3_tco2e=values.get("scope3_tco2e"),
        employees=int(employees) if employees is not None else None,
        turnover=values.get("turnover"), energy_mwh=values.get("energy_mwh"),
        document=document, format=fmt, missing=missing,
    ))
    if "scope1_tco2e" in missing or ("scope2_location_tco2e" in missing and "scope2_market_tco2e" in missing):
        result.errors.append(IngestError("vsme", f"return does not carry {', '.join(missing)}"))
    return result


# --- xBRL-JSON ---------------------------------------------------------------

def _read_xbrl_json(raw: bytes) -> dict[str, float]:
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise ValueError(f"neither an xlsx nor JSON: {e}") from None
    facts = body.get("facts") if isinstance(body, dict) else None
    if not isinstance(facts, dict):
        raise ValueError("xBRL-JSON has no facts object")
    by_local: dict[str, float] = {}
    for fact in facts.values():
        if not isinstance(fact, dict):
            continue
        dims = fact.get("dimensions") or {}
        concept = str(dims.get("concept") or "")
        local = concept.split(":")[-1]
        if not local:
            continue
        # Dimensionally qualified facts (a segment, a site) are not the entity total.
        if any(k not in ("concept", "entity", "period", "unit", "language") for k in dims):
            continue
        try:
            by_local[local] = float(str(fact.get("value")).replace(",", ""))
        except ValueError:
            continue
    out: dict[str, float] = {}
    for key, (_, names) in CONCEPTS.items():
        for n in names:
            if n in by_local:
                out[key] = by_local[n]
                break
    return out


# --- xlsx ---------------------------------------------------------------------

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
_CELL_RE = re.compile(r"([A-Z]+)(\d+)")


def _col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def _read_xlsx(raw: bytes) -> dict[str, float]:
    try:
        z = zipfile.ZipFile(BytesIO(raw))
    except zipfile.BadZipFile:
        raise ValueError("not a valid xlsx") from None
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("m:si", _NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))
    grid: dict[tuple[int, int], object] = {}
    sheets = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
    if not sheets:
        raise ValueError("xlsx has no worksheets")
    for sheet in sheets:
        root = ET.fromstring(z.read(sheet))
        for c in root.iter(f"{{{_NS['m']}}}c"):
            ref = c.get("r") or ""
            m = _CELL_RE.match(ref)
            if not m:
                continue
            col, row = _col_index(m.group(1)), int(m.group(2))
            t = c.get("t")
            v = c.find("m:v", _NS)
            if t == "inlineStr":
                is_ = c.find("m:is", _NS)
                text = "".join(x.text or "" for x in is_.iter(f"{{{_NS['m']}}}t")) if is_ is not None else ""
                grid[(sheet, row, col)] = text  # type: ignore[index]
            elif v is not None and v.text is not None:
                if t == "s":
                    grid[(sheet, row, col)] = shared[int(v.text)]  # type: ignore[index]
                else:
                    try:
                        grid[(sheet, row, col)] = float(v.text)  # type: ignore[index]
                    except ValueError:
                        grid[(sheet, row, col)] = v.text  # type: ignore[index]
    out: dict[str, float] = {}
    for (sheet, row, col), value in grid.items():  # type: ignore[misc]
        if not isinstance(value, str):
            continue
        label = value.strip().lower()
        for key, (patterns, _) in CONCEPTS.items():
            if key in out or not any(re.search(p, label) for p in patterns):
                continue
            # The value is the first numeric cell to the right on the same row.
            for c2 in range(col + 1, col + 12):
                cand = grid.get((sheet, row, c2))  # type: ignore[arg-type]
                if isinstance(cand, float):
                    out[key] = cand
                    break
                if isinstance(cand, str) and cand.strip():
                    try:
                        out[key] = float(cand.replace(",", ""))
                        break
                    except ValueError:
                        continue  # a unit label such as "tCO2e"; keep looking
    return out
