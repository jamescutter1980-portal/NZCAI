"""Dataclasses and enums to JSON-safe values, one way, with no surprises."""

from __future__ import annotations

import dataclasses
from datetime import date, datetime
from enum import Enum
from typing import Any

__all__ = ["to_json"]


def to_json(value: Any) -> Any:
    if isinstance(value, Enum):  # before the primitives: str-enums are strs
        return value.value
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out = {f.name: to_json(getattr(value, f.name)) for f in dataclasses.fields(value)}
        # Derived properties the UI wants without recomputing them.
        for name in ("has_lineage", "is_dominant", "spans_value_chain", "may_be_asked_beyond_vsme",
                     "submission_ready", "usable", "complete_for_allocation", "scope2_tco2e",
                     "resolved", "needs_review", "days", "share_gain"):
            if hasattr(type(value), name) and isinstance(getattr(type(value), name), property):
                out[name] = to_json(getattr(value, name))
        return out
    if isinstance(value, dict):
        return {str(k.value if isinstance(k, Enum) else k): to_json(v) for k, v in value.items()}
    if isinstance(value, (frozenset, set)):
        return sorted(to_json(v) for v in value)
    if isinstance(value, (list, tuple)):
        return [to_json(v) for v in value]
    if hasattr(value, "__dict__"):
        return {k: to_json(v) for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)
