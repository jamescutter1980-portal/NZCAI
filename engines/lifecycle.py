"""The engagement state machine.

One instance per data need, per relationship, per reporting period. The point
of modelling this explicitly rather than as a "sent" flag is that last year's
dossier becomes this year's starting point, and that a lapsed certificate
re-opens a chase with nobody having to remember.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 4.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
from typing import Optional

from .types import DeclineReason, EngagementState as S

__all__ = [
    "Engagement",
    "AuditRow",
    "InvalidTransition",
    "ALLOWED",
    "TERMINAL",
    "OPEN",
    "can_transition",
    "transition",
    "is_open",
]


class InvalidTransition(ValueError):
    """Raised when a caller tries to move an engagement somewhere it cannot go."""


#: Permitted moves. Anything absent is rejected, so a bug in a caller shows up
#: as a loud failure rather than a silently corrupt dossier.
ALLOWED: dict[S, frozenset[S]] = {
    S.UNIDENTIFIED: frozenset({S.IDENTIFIED}),
    S.IDENTIFIED: frozenset({S.ENRICHED, S.UNREACHABLE}),
    # Enrichment can satisfy the whole need on its own, in which case no
    # request is ever sent. That path is the point of asking last.
    S.ENRICHED: frozenset({S.SCOPED}),
    S.SCOPED: frozenset({S.CONTACTED, S.COMPLETE}),
    # Re-contact stays in CONTACTED: escalation moves the person, not the state.
    S.CONTACTED: frozenset(
        {S.CONTACTED, S.ENGAGED, S.DECLINED, S.UNREACHABLE, S.PARTIAL}
    ),
    S.ENGAGED: frozenset({S.RESPONDING, S.DECLINED}),
    S.RESPONDING: frozenset({S.PARTIAL, S.COMPLETE, S.DECLINED}),
    S.PARTIAL: frozenset({S.PARTIAL, S.COMPLETE, S.DECLINED}),
    S.COMPLETE: frozenset({S.VERIFIED, S.PARTIAL}),
    S.VERIFIED: frozenset({S.LAPSED, S.SUPERSEDED}),
    # A refusal this period is not a refusal for ever.
    S.DECLINED: frozenset({S.SCOPED}),
    S.UNREACHABLE: frozenset({S.IDENTIFIED, S.SCOPED}),
    S.LAPSED: frozenset({S.SCOPED}),
    S.SUPERSEDED: frozenset(),
}

#: States from which nothing further happens without a new period.
TERMINAL: frozenset[S] = frozenset({S.SUPERSEDED})

#: States where work is outstanding and the engagement belongs on a worklist.
OPEN: frozenset[S] = frozenset(
    {
        S.UNIDENTIFIED,
        S.IDENTIFIED,
        S.ENRICHED,
        S.SCOPED,
        S.CONTACTED,
        S.ENGAGED,
        S.RESPONDING,
        S.PARTIAL,
        S.LAPSED,
    }
)


@dataclass(frozen=True)
class AuditRow:
    """Immutable record of one transition. Written for every move, no exceptions."""

    engagement_id: str
    from_state: S
    to_state: S
    actor: str
    trigger: str
    at: date
    evidence_id: Optional[str] = None


@dataclass(frozen=True)
class Engagement:
    """One data need being pursued with one counterparty for one period."""

    id: str
    counterparty_id: str
    period: int
    state: S = S.UNIDENTIFIED
    entered_at: Optional[date] = None
    deadline: Optional[date] = None
    decline_reason: Optional[DeclineReason] = None
    contact_attempts: int = 0


def is_open(state: S) -> bool:
    """True where the engagement still needs someone to do something."""
    return state in OPEN


def can_transition(frm: S, to: S) -> bool:
    return to in ALLOWED.get(frm, frozenset())


def transition(
    engagement: Engagement,
    to: S,
    *,
    actor: str,
    trigger: str,
    at: date,
    decline_reason: Optional[DeclineReason] = None,
    evidence_id: Optional[str] = None,
) -> tuple[Engagement, AuditRow]:
    """Move an engagement, returning the new value and the audit row to persist.

    The engagement is frozen and a new one is returned rather than mutated, so
    a caller cannot accidentally advance state without also writing the audit
    row: both come back together or neither does.

    Raises:
        InvalidTransition: where the move is not in ALLOWED, or where a
            declined engagement carries no reason code.
    """
    if not can_transition(engagement.state, to):
        raise InvalidTransition(
            f"cannot move engagement {engagement.id} from {engagement.state.value} "
            f"to {to.value}"
        )

    if to is S.DECLINED and decline_reason is None:
        raise InvalidTransition(
            "a declined engagement must record why, so the chase engine knows "
            "whether it may ask again"
        )

    attempts = engagement.contact_attempts
    if to is S.CONTACTED:
        attempts += 1

    moved = replace(
        engagement,
        state=to,
        entered_at=at,
        decline_reason=decline_reason or engagement.decline_reason,
        contact_attempts=attempts,
    )
    row = AuditRow(
        engagement_id=engagement.id,
        from_state=engagement.state,
        to_state=to,
        actor=actor,
        trigger=trigger,
        at=at,
        evidence_id=evidence_id,
    )
    return moved, row
