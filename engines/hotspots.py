"""Where the emissions are, and what moves them.

Ranking is the easy half. The levers are the useful half: what happens to the
inventory if a factor is swapped for a supplier's own, a quantity is cut, or
fuel sold declines as charging grows. Each lever returns a new list of figures
rather than editing the old one, so a what-if never leaks into the record.

Reference: docs/product/nzc-ai-scope-3-brief.md section 5, hotspots.py.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable, Iterable, Literal, Optional, Sequence

from .types import Figure, Tier

__all__ = ["Hotspot", "rank", "lever_substitute_factor", "lever_scale", "lever_effect"]

Dimension = Literal["category", "counterparty", "entity", "factor"]


@dataclass(frozen=True)
class Hotspot:
    key: str
    tco2e: float
    share: float
    figures: int


def _key_of(figure: Figure, by: Dimension) -> str:
    if by == "category":
        return figure.category.value
    if by == "counterparty":
        return figure.counterparty_id or "(unattributed)"
    if by == "entity":
        return figure.entity_id or "(no entity)"
    if by == "factor":
        return figure.factor_key or figure.factor_source
    raise ValueError(f"unknown dimension {by!r}")


def rank(figures: Sequence[Figure], *, by: Dimension = "category", top: Optional[int] = None) -> list[Hotspot]:
    """Contributors along one dimension, heaviest first."""
    total = sum(f.tco2e for f in figures)
    buckets: dict[str, list[Figure]] = {}
    for f in figures:
        buckets.setdefault(_key_of(f, by), []).append(f)
    spots = [
        Hotspot(
            key=k,
            tco2e=sum(f.tco2e for f in v),
            share=(sum(f.tco2e for f in v) / total) if total else 0.0,
            figures=len(v),
        )
        for k, v in buckets.items()
    ]
    spots.sort(key=lambda h: h.tco2e, reverse=True)
    return spots[:top] if top else spots


def lever_substitute_factor(
    figures: Iterable[Figure],
    *,
    factor_key: str,
    new_kgco2e: float,
    new_source: str,
    new_version: str,
    new_tier: Tier,
) -> list[Figure]:
    """Recompute every figure on one factor with a different factor.

    The usual case is a supplier's own footprint replacing an average factor,
    which changes both the number and the tier. Figures without lineage cannot
    be recomputed and are passed through unchanged.
    """
    out: list[Figure] = []
    for f in figures:
        if f.factor_key == factor_key and f.has_lineage:
            out.append(
                replace(
                    f,
                    tco2e=f.activity_quantity * new_kgco2e / 1000.0,
                    tier=new_tier,
                    factor_source=new_source,
                    factor_version=new_version,
                    factor_kgco2e=new_kgco2e,
                    method_label=(
                        f"{f.method_label or ''} [what-if: factor replaced with "
                        f"{new_source} {new_version}]"
                    ).strip(),
                )
            )
        else:
            out.append(f)
    return out


def lever_scale(
    figures: Iterable[Figure],
    *,
    where: Callable[[Figure], bool],
    multiplier: float,
    label: str,
) -> list[Figure]:
    """Scale the quantity, and so the emissions, of every matching figure.

    A multiplier of 0.8 on fuel sold models a fifth of forecourt volume moving
    to charging; 0 models exit from a supplier.
    """
    if multiplier < 0:
        raise ValueError("multiplier must not be negative")
    out: list[Figure] = []
    for f in figures:
        if where(f):
            quantity = f.activity_quantity * multiplier if f.activity_quantity is not None else None
            out.append(
                replace(
                    f,
                    tco2e=f.tco2e * multiplier,
                    activity_quantity=quantity,
                    method_label=f"{f.method_label or ''} [what-if: {label}, x{multiplier:g}]".strip(),
                )
            )
        else:
            out.append(f)
    return out


def lever_effect(before: Sequence[Figure], after: Sequence[Figure]) -> dict[str, float]:
    """Totals before and after a lever, and the difference."""
    b = sum(f.tco2e for f in before)
    a = sum(f.tco2e for f in after)
    return {"before_tco2e": b, "after_tco2e": a, "delta_tco2e": a - b, "delta_share": (a - b) / b if b else 0.0}
