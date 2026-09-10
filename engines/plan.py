"""Chase planning: cadence, the escalation ladder, and fatigue control.

Two rules do most of the work here. Waves are planned backwards from the date
the data is actually needed, not forwards from today, so the last resort still
lands with two weeks to spare. And escalation moves the person, never the
frequency: sending more mail to a contact who is not replying is how a
supplier relationship is spent for nothing.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md sections 8.2 to 8.3.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable, Optional, Sequence

from .types import ContactRung, Counterparty, RequestTemplate

__all__ = [
    "Step",
    "CADENCE",
    "build_schedule",
    "next_step",
    "template_for",
    "may_contact",
    "batch_needs",
]


@dataclass(frozen=True)
class Step:
    """One planned contact, with the rung of the ladder it goes to."""

    due: date
    weeks_before: int
    rung: ContactRung
    action: str
    #: The last step is not a contact at all: it is the decision to fall back
    #: to a secondary estimate and tell the counterparty what we assumed.
    is_fallback: bool = False


#: Weeks before the deadline, the rung, and what happens. Escalation walks up
#: the ladder; the interval widens rather than narrowing.
CADENCE: tuple[tuple[int, ContactRung, str, bool], ...] = (
    (16, ContactRung.DAY_TO_DAY, "First contact, pre-filled from public sources", False),
    (12, ContactRung.DAY_TO_DAY, "Reminder, restating only what is outstanding", False),
    (9, ContactRung.ACCOUNT_MANAGER, "Escalate to the account manager", False),
    (6, ContactRung.SUSTAINABILITY_LEAD, "Escalate to their sustainability lead", False),
    (4, ContactRung.COMMERCIAL, "Commercial escalation through our own buyer", False),
    (
        2,
        ContactRung.COMMERCIAL,
        "Fall back to a secondary estimate and tell them what was assumed",
        True,
    ),
)

#: Minimum days between contacts to one counterparty, across every client we
#: act for. A supplier serving three of our clients gets one combined request,
#: not three.
MIN_CONTACT_GAP_DAYS = 21


def build_schedule(deadline: date) -> list[Step]:
    """Plan the wave backwards from the date the data is needed.

    Steps that fall in the past are still returned. A programme started late
    needs to see which rungs it has already missed, not a schedule that
    quietly pretends it began on time.
    """
    return [
        Step(
            due=deadline - timedelta(weeks=weeks),
            weeks_before=weeks,
            rung=rung,
            action=action,
            is_fallback=is_fallback,
        )
        for weeks, rung, action, is_fallback in CADENCE
    ]


def next_step(schedule: Sequence[Step], today: date) -> Optional[Step]:
    """The next step due, or the earliest overdue one if the plan has slipped.

    Returns None once the fallback has passed, at which point the engagement
    is decided rather than pending.
    """
    overdue = [s for s in schedule if s.due <= today]
    upcoming = [s for s in schedule if s.due > today]

    if overdue and upcoming:
        # Behind schedule: act on the most recent rung reached, not the first
        # one missed, so a late start does not replay the whole ladder.
        return max(overdue, key=lambda s: s.due)
    if upcoming:
        return min(upcoming, key=lambda s: s.due)
    if overdue:
        last = max(overdue, key=lambda s: s.due)
        return None if last.is_fallback else last
    return None


def template_for(
    counterparty: Counterparty, *, needs_product_footprints: bool = False
) -> RequestTemplate:
    """Which standard to ask in.

    Never a bespoke questionnaire. A counterparty below the employee threshold
    is asked in the voluntary SME standard whatever else we might want, because
    it may lawfully decline anything more and asking anyway spends goodwill for
    a refusal.
    """
    if not counterparty.may_be_asked_beyond_vsme:
        return RequestTemplate.VSME
    if needs_product_footprints:
        return RequestTemplate.PACT
    return RequestTemplate.GHG_CATEGORY


def may_contact(
    last_contacted: Optional[date],
    today: date,
    *,
    min_gap_days: int = MIN_CONTACT_GAP_DAYS,
) -> bool:
    """Whether enough time has passed since this counterparty was last asked.

    Applies across clients, not within one. The fatigue this guards against is
    the supplier's, and the supplier does not care which of our clients each
    request was for.
    """
    if last_contacted is None:
        return True
    return (today - last_contacted).days >= min_gap_days


def batch_needs(needs: Iterable[tuple[str, str]]) -> dict[str, list[str]]:
    """Group outstanding data needs into one request per counterparty.

    Args:
        needs: pairs of counterparty id and the field or category needed.

    Returns:
        Counterparty id to its list of needs, de-duplicated and ordered, ready
        to become a single message rather than several.
    """
    batched: dict[str, list[str]] = {}
    for counterparty_id, need in needs:
        batched.setdefault(counterparty_id, [])
        if need not in batched[counterparty_id]:
            batched[counterparty_id].append(need)
    return {k: sorted(v) for k, v in batched.items()}
