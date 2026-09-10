"""Rolling an inventory up from entities to a parent.

Emissions consolidate by addition, so the work here is bookkeeping: keep the
entity behind every tonne so the parent's statement can be decomposed, tag
entities for the parent's own chart of categories, and refuse to double count
a figure that belongs to two entities. Currency conversion does not belong
here; tonnes have no currency. It belongs to spend, in the ledger.

Reference: docs/product/nzc-ai-scope-3-brief.md section 5, consolidate.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence

from .types import Category, Figure

__all__ = ["Entity", "Consolidated", "consolidate"]


@dataclass(frozen=True)
class Entity:
    id: str
    name: str
    #: Free tags the parent uses to slice the consolidation, for instance
    #: "uk", "motorway", "hotels". Order is not significant.
    tags: frozenset[str] = field(default_factory=frozenset)
    #: Share of the entity the parent consolidates, for partly owned entities
    #: under an equity-share approach. 1.0 under operational control.
    consolidation_share: float = 1.0

    def __post_init__(self) -> None:
        if not 0.0 < self.consolidation_share <= 1.0:
            raise ValueError("consolidation_share must be in (0, 1]")


@dataclass(frozen=True)
class Consolidated:
    total_tco2e: float
    by_category: dict[Category, float]
    by_entity: dict[str, float]
    by_category_and_entity: dict[tuple[Category, str], float]
    by_tag: dict[str, float]
    entities: int
    figures: int

    def category_row(self, category: Category) -> dict[str, float]:
        """One category decomposed by entity, for the parent's E1-6 working."""
        return {
            entity: tco2e
            for (cat, entity), tco2e in self.by_category_and_entity.items()
            if cat is category
        }


def consolidate(
    figures: Iterable[Figure],
    entities: Mapping[str, Entity],
) -> Consolidated:
    """Sum an inventory across entities, applying each entity's share.

    Every figure must carry an `entity_id` present in `entities`; a figure
    with no entity cannot be consolidated because the parent could not say
    whose it is, and that is refused rather than silently attributed.
    """
    by_category: dict[Category, float] = {}
    by_entity: dict[str, float] = {}
    by_both: dict[tuple[Category, str], float] = {}
    by_tag: dict[str, float] = {}
    count = 0

    for f in figures:
        if f.entity_id is None:
            raise ValueError(
                f"figure in category {f.category.value} has no entity_id and "
                "cannot be consolidated"
            )
        try:
            entity = entities[f.entity_id]
        except KeyError:
            raise ValueError(f"figure references unknown entity {f.entity_id!r}") from None

        t = f.tco2e * entity.consolidation_share
        by_category[f.category] = by_category.get(f.category, 0.0) + t
        by_entity[entity.id] = by_entity.get(entity.id, 0.0) + t
        by_both[(f.category, entity.id)] = by_both.get((f.category, entity.id), 0.0) + t
        for tag in entity.tags:
            by_tag[tag] = by_tag.get(tag, 0.0) + t
        count += 1

    return Consolidated(
        total_tco2e=sum(by_category.values()),
        by_category=dict(sorted(by_category.items(), key=lambda kv: int(kv[0].value))),
        by_entity=by_entity,
        by_category_and_entity=by_both,
        by_tag=by_tag,
        entities=len(by_entity),
        figures=count,
    )
