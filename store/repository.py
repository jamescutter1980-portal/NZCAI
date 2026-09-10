"""The working store: SQLite, organisation-scoped, append-only where it matters.

Every method takes an org_id and every query filters on it. That is the
SQLite stand-in for the row-level security the Postgres migration declares,
and the tests prove one organisation cannot read another's rows through any
method here.

The one method that matters most is :meth:`Store.transition_engagement`. It
calls the lifecycle engine, which returns the new state and the audit row
together, and writes both in one transaction. There is no method that writes
one without the other.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from datetime import date, datetime
from typing import Iterable, Optional, Sequence

from engines.conflict import Conflict, ConflictClass
from engines.disclosure import disclosable
from engines.lifecycle import AuditRow, Engagement, transition
from engines.outcome import AttemptOutcome
from engines.types import (
    Category,
    Confidentiality,
    ContactRung,
    Counterparty,
    DeclineReason,
    Document,
    DocumentType,
    EngagementState,
    Figure,
    RelationshipRole,
    RequestTemplate,
    Tier,
)

from .schema import SCHEMA

__all__ = ["Store", "NotFound", "Proposal"]


class NotFound(LookupError):
    """No row for that organisation and id. Deliberately the same error whether
    the row exists for another organisation or not at all."""


def _d(value: Optional[date]) -> Optional[str]:
    return value.isoformat() if value else None


def _pd(value: Optional[str]) -> Optional[date]:
    return date.fromisoformat(value) if value else None


class Proposal:
    """An agent's suggestion awaiting a person. Plain object, not a dataclass,
    because it is only ever built from a row."""

    def __init__(self, row: sqlite3.Row):
        self.id: int = row["id"]
        self.agent: str = row["agent"]
        self.kind: str = row["kind"]
        self.payload: dict = json.loads(row["payload"])
        self.confidence: Optional[float] = row["confidence"]
        self.status: str = row["status"]
        self.decided_by: Optional[str] = row["decided_by"]
        self.created_at: str = row["created_at"]

    def __repr__(self) -> str:
        return f"Proposal({self.id}, {self.agent}, {self.kind}, {self.status})"


class Store:
    def __init__(self, connection: sqlite3.Connection):
        self._c = connection
        self._c.row_factory = sqlite3.Row
        self._c.execute("pragma foreign_keys = on")
        self._c.executescript(SCHEMA)

    @classmethod
    def open(cls, path: str = ":memory:") -> "Store":
        return cls(sqlite3.connect(path, isolation_level=None))

    def close(self) -> None:
        self._c.close()

    # ------------------------------------------------------------------
    # Organisations
    # ------------------------------------------------------------------

    def ensure_organisation(self, org_id: str, name: str) -> None:
        self._c.execute(
            "insert or ignore into organisation (id, name) values (?, ?)", (org_id, name)
        )

    # ------------------------------------------------------------------
    # Counterparties
    # ------------------------------------------------------------------

    def save_counterparty(self, org_id: str, cp: Counterparty) -> None:
        self._c.execute(
            """insert or replace into counterparty (
                id, org_id, name, roles, company_number, employee_band, turnover_gbp,
                has_public_report, is_cdp_responder, has_validated_target,
                has_named_contact, responded_before, contractual_data_right,
                emissions_intensive_commodity, contract_end
            ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                cp.id, org_id, cp.name, json.dumps(sorted(r.value for r in cp.roles)),
                cp.company_number, cp.employee_band, cp.turnover_gbp,
                int(cp.has_public_report), int(cp.is_cdp_responder),
                int(cp.has_validated_target), int(cp.has_named_contact),
                int(cp.responded_before), int(cp.contractual_data_right),
                cp.emissions_intensive_commodity, _d(cp.contract_end),
            ),
        )

    def get_counterparty(self, org_id: str, cp_id: str) -> Counterparty:
        row = self._c.execute(
            "select * from counterparty where org_id = ? and id = ?", (org_id, cp_id)
        ).fetchone()
        if row is None:
            raise NotFound(f"counterparty {cp_id}")
        return self._counterparty(row)

    def list_counterparties(self, org_id: str) -> list[Counterparty]:
        rows = self._c.execute(
            "select * from counterparty where org_id = ? order by name", (org_id,)
        ).fetchall()
        return [self._counterparty(r) for r in rows]

    @staticmethod
    def _counterparty(row: sqlite3.Row) -> Counterparty:
        return Counterparty(
            id=row["id"],
            name=row["name"],
            roles=frozenset(RelationshipRole(r) for r in json.loads(row["roles"])),
            company_number=row["company_number"],
            employee_band=row["employee_band"],
            turnover_gbp=row["turnover_gbp"],
            has_public_report=bool(row["has_public_report"]),
            is_cdp_responder=bool(row["is_cdp_responder"]),
            has_validated_target=bool(row["has_validated_target"]),
            has_named_contact=bool(row["has_named_contact"]),
            responded_before=bool(row["responded_before"]),
            contractual_data_right=bool(row["contractual_data_right"]),
            emissions_intensive_commodity=row["emissions_intensive_commodity"],
            contract_end=_pd(row["contract_end"]),
        )

    # ------------------------------------------------------------------
    # Figures: append-only
    # ------------------------------------------------------------------

    def save_figures(
        self, org_id: str, period: int, figures: Iterable[Figure], *, created_by: str = "engine"
    ) -> list[int]:
        ids: list[int] = []
        for f in figures:
            cur = self._c.execute(
                """insert into figure (
                    org_id, period, category, tco2e, tier, factor_source, factor_version,
                    counterparty_id, document_id, achievable_tier, entity_id,
                    activity_quantity, activity_unit, factor_key, factor_kgco2e,
                    method_label, created_by
                ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    org_id, period, f.category.value, f.tco2e, f.tier.value,
                    f.factor_source, f.factor_version, f.counterparty_id, f.document_id,
                    f.achievable_tier.value if f.achievable_tier else None, f.entity_id,
                    f.activity_quantity, f.activity_unit, f.factor_key, f.factor_kgco2e,
                    f.method_label, created_by,
                ),
            )
            ids.append(cur.lastrowid)
        return ids

    def supersede_figure(
        self, org_id: str, old_id: int, replacement: Figure, *, actor: str
    ) -> int:
        """Correct a figure by inserting its replacement. The old row stays."""
        old = self._c.execute(
            "select id, period, status from figure where org_id = ? and id = ?", (org_id, old_id)
        ).fetchone()
        if old is None:
            raise NotFound(f"figure {old_id}")
        if old["status"] != "active":
            raise ValueError(f"figure {old_id} is already superseded")
        cur = self._c.execute(
            """insert into figure (
                org_id, period, category, tco2e, tier, factor_source, factor_version,
                counterparty_id, document_id, achievable_tier, entity_id,
                activity_quantity, activity_unit, factor_key, factor_kgco2e,
                method_label, supersedes_id, created_by
            ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                org_id, old["period"], replacement.category.value, replacement.tco2e,
                replacement.tier.value, replacement.factor_source, replacement.factor_version,
                replacement.counterparty_id, replacement.document_id,
                replacement.achievable_tier.value if replacement.achievable_tier else None,
                replacement.entity_id, replacement.activity_quantity, replacement.activity_unit,
                replacement.factor_key, replacement.factor_kgco2e, replacement.method_label,
                old_id, actor,
            ),
        )
        return cur.lastrowid

    def list_figures(
        self, org_id: str, period: int, *, include_superseded: bool = False
    ) -> list[Figure]:
        sql = "select * from figure where org_id = ? and period = ?"
        if not include_superseded:
            sql += " and status = 'active'"
        rows = self._c.execute(sql + " order by id", (org_id, period)).fetchall()
        return [self._figure(r) for r in rows]

    def figure_lineage(self, org_id: str, figure_id: int) -> list[dict]:
        """The chain of corrections ending at this figure, oldest first."""
        chain: list[dict] = []
        current = self._c.execute(
            "select * from figure where org_id = ? and id = ?", (org_id, figure_id)
        ).fetchone()
        if current is None:
            raise NotFound(f"figure {figure_id}")
        while current is not None:
            chain.append(dict(current))
            if current["supersedes_id"] is None:
                break
            current = self._c.execute(
                "select * from figure where org_id = ? and id = ?",
                (org_id, current["supersedes_id"]),
            ).fetchone()
        chain.reverse()
        return chain

    @staticmethod
    def _figure(row: sqlite3.Row) -> Figure:
        return Figure(
            category=Category(row["category"]),
            tco2e=row["tco2e"],
            tier=Tier(row["tier"]),
            factor_source=row["factor_source"],
            factor_version=row["factor_version"],
            counterparty_id=row["counterparty_id"],
            document_id=row["document_id"],
            achievable_tier=Tier(row["achievable_tier"]) if row["achievable_tier"] else None,
            entity_id=row["entity_id"],
            activity_quantity=row["activity_quantity"],
            activity_unit=row["activity_unit"],
            factor_key=row["factor_key"],
            factor_kgco2e=row["factor_kgco2e"],
            method_label=row["method_label"],
        )

    # ------------------------------------------------------------------
    # Engagements and the audit trail
    # ------------------------------------------------------------------

    def save_engagement(self, org_id: str, e: Engagement) -> None:
        self._c.execute(
            """insert or replace into engagement (
                id, org_id, counterparty_id, period, state, entered_at, deadline,
                decline_reason, contact_attempts
            ) values (?,?,?,?,?,?,?,?,?)""",
            (
                e.id, org_id, e.counterparty_id, e.period, e.state.value, _d(e.entered_at),
                _d(e.deadline), e.decline_reason.value if e.decline_reason else None,
                e.contact_attempts,
            ),
        )

    def get_engagement(self, org_id: str, eng_id: str) -> Engagement:
        row = self._c.execute(
            "select * from engagement where org_id = ? and id = ?", (org_id, eng_id)
        ).fetchone()
        if row is None:
            raise NotFound(f"engagement {eng_id}")
        return self._engagement(row)

    def list_engagements(
        self, org_id: str, *, period: Optional[int] = None, state: Optional[EngagementState] = None
    ) -> list[Engagement]:
        sql, args = "select * from engagement where org_id = ?", [org_id]
        if period is not None:
            sql += " and period = ?"; args.append(period)
        if state is not None:
            sql += " and state = ?"; args.append(state.value)
        return [self._engagement(r) for r in self._c.execute(sql + " order by id", args)]

    def transition_engagement(
        self,
        org_id: str,
        eng_id: str,
        to: EngagementState,
        *,
        actor: str,
        trigger: str,
        at: date,
        decline_reason: Optional[DeclineReason] = None,
        evidence_id: Optional[str] = None,
    ) -> tuple[Engagement, AuditRow]:
        """Advance an engagement and record why, atomically.

        The lifecycle engine decides whether the move is allowed and hands back
        the new state with its audit row. Both are written in one transaction:
        if either insert fails, neither lands.
        """
        current = self.get_engagement(org_id, eng_id)
        moved, row = transition(
            current, to, actor=actor, trigger=trigger, at=at,
            decline_reason=decline_reason, evidence_id=evidence_id,
        )
        self._c.execute("begin")
        try:
            self.save_engagement(org_id, moved)
            self._c.execute(
                """insert into audit_row (
                    org_id, engagement_id, from_state, to_state, actor, trigger, at, evidence_id
                ) values (?,?,?,?,?,?,?,?)""",
                (
                    org_id, row.engagement_id, row.from_state.value, row.to_state.value,
                    row.actor, row.trigger, _d(row.at), row.evidence_id,
                ),
            )
            self._c.execute("commit")
        except Exception:
            self._c.execute("rollback")
            raise
        return moved, row

    def audit_trail(self, org_id: str, eng_id: str) -> list[AuditRow]:
        rows = self._c.execute(
            "select * from audit_row where org_id = ? and engagement_id = ? order by id",
            (org_id, eng_id),
        ).fetchall()
        return [
            AuditRow(
                engagement_id=r["engagement_id"],
                from_state=EngagementState(r["from_state"]),
                to_state=EngagementState(r["to_state"]),
                actor=r["actor"],
                trigger=r["trigger"],
                at=date.fromisoformat(r["at"]),
                evidence_id=r["evidence_id"],
            )
            for r in rows
        ]

    @staticmethod
    def _engagement(row: sqlite3.Row) -> Engagement:
        return Engagement(
            id=row["id"],
            counterparty_id=row["counterparty_id"],
            period=row["period"],
            state=EngagementState(row["state"]),
            entered_at=_pd(row["entered_at"]),
            deadline=_pd(row["deadline"]),
            decline_reason=DeclineReason(row["decline_reason"]) if row["decline_reason"] else None,
            contact_attempts=row["contact_attempts"],
        )

    # ------------------------------------------------------------------
    # Documents, with disclosure applied on read
    # ------------------------------------------------------------------

    def save_document(self, org_id: str, doc: Document, *, storage_key: Optional[str] = None, sha256: Optional[str] = None) -> None:
        owner = doc.owner_org_id or org_id
        storage_key = storage_key or doc.storage_key
        sha256 = sha256 or doc.sha256
        self._c.execute(
            """insert or replace into document (
                id, org_id, counterparty_id, doc_type, issue_date, confidentiality,
                period_covered, valid_to, consented_org_ids, storage_key, sha256
            ) values (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                doc.id, owner, doc.counterparty_id, doc.doc_type.value, _d(doc.issue_date),
                doc.confidentiality.value, doc.period_covered, _d(doc.valid_to),
                json.dumps(sorted(doc.consented_org_ids)), storage_key, sha256,
            ),
        )

    def list_documents(self, owner_org_id: str) -> list[Document]:
        """Everything an organisation holds. Owner's view; no filtering needed."""
        rows = self._c.execute(
            "select * from document where org_id = ? order by issue_date", (owner_org_id,)
        ).fetchall()
        return [self._document(r) for r in rows]

    def visible_documents(self, *, to_org_id: str) -> list[Document]:
        """Every document this organisation may see, from any owner.

        Candidate rows are pre-filtered in SQL to what could possibly qualify,
        then the disclosure engine makes the actual decision, so the rule lives
        in one place even when the query is optimised.
        """
        rows = self._c.execute(
            """select * from document
               where org_id = ? or confidentiality = 'public'
                  or (confidentiality = 'consented_reuse' and consented_org_ids like ?)
               order by issue_date""",
            (to_org_id, f'%"{to_org_id}"%'),
        ).fetchall()
        return disclosable((self._document(r) for r in rows), to_org_id=to_org_id)

    @staticmethod
    def _document(row: sqlite3.Row) -> Document:
        return Document(
            id=row["id"],
            counterparty_id=row["counterparty_id"],
            doc_type=DocumentType(row["doc_type"]),
            issue_date=date.fromisoformat(row["issue_date"]),
            confidentiality=Confidentiality(row["confidentiality"]),
            period_covered=row["period_covered"],
            valid_to=_pd(row["valid_to"]),
            owner_org_id=row["org_id"],
            consented_org_ids=frozenset(json.loads(row["consented_org_ids"])),
            storage_key=row["storage_key"],
            sha256=row["sha256"],
        )

    # ------------------------------------------------------------------
    # Conflicts
    # ------------------------------------------------------------------

    def save_conflict(self, org_id: str, c: Conflict) -> int:
        cur = self._c.execute(
            """insert into conflict (
                org_id, conflict_class, subject, value_a, source_a, value_b, source_b,
                proposed_resolution, rationale
            ) values (?,?,?,?,?,?,?,?,?)""",
            (
                org_id, c.conflict_class.value, c.subject, c.value_a, c.source_a,
                c.value_b, c.source_b, c.proposed_resolution, c.rationale,
            ),
        )
        return cur.lastrowid

    def decide_conflict(self, org_id: str, conflict_id: int, *, decision: str, decided_by: str) -> None:
        cur = self._c.execute(
            """update conflict set decision = ?, decided_by = ?, decided_at = ?
               where org_id = ? and id = ? and decision is null""",
            (decision, decided_by, datetime.utcnow().isoformat(), org_id, conflict_id),
        )
        if cur.rowcount == 0:
            raise NotFound(f"open conflict {conflict_id}")

    def list_conflicts(self, org_id: str, *, open_only: bool = True) -> list[dict]:
        sql = "select * from conflict where org_id = ?"
        if open_only:
            sql += " and decision is null"
        return [dict(r) for r in self._c.execute(sql + " order by id", (org_id,))]

    # ------------------------------------------------------------------
    # Agent proposals: the review queue
    # ------------------------------------------------------------------

    def save_proposal(self, org_id: str, *, agent: str, kind: str, payload: dict, confidence: Optional[float]) -> int:
        cur = self._c.execute(
            "insert into proposal (org_id, agent, kind, payload, confidence) values (?,?,?,?,?)",
            (org_id, agent, kind, json.dumps(payload), confidence),
        )
        return cur.lastrowid

    def list_proposals(self, org_id: str, *, status: str = "pending") -> list[Proposal]:
        rows = self._c.execute(
            "select * from proposal where org_id = ? and status = ? order by id", (org_id, status)
        ).fetchall()
        return [Proposal(r) for r in rows]

    def decide_proposal(self, org_id: str, proposal_id: int, *, accept: bool, decided_by: str) -> Proposal:
        cur = self._c.execute(
            """update proposal set status = ?, decided_by = ?, decided_at = ?
               where org_id = ? and id = ? and status = 'pending'""",
            ("accepted" if accept else "rejected", decided_by, datetime.utcnow().isoformat(), org_id, proposal_id),
        )
        if cur.rowcount == 0:
            raise NotFound(f"pending proposal {proposal_id}")
        row = self._c.execute("select * from proposal where org_id = ? and id = ?", (org_id, proposal_id)).fetchone()
        return Proposal(row)

    # ------------------------------------------------------------------
    # Attempt outcomes
    # ------------------------------------------------------------------

    def save_outcome(self, org_id: str, o: AttemptOutcome) -> None:
        self._c.execute(
            """insert into attempt_outcome (
                org_id, counterparty_id, channel, rung, prefilled, template, sent,
                responded, hours_to_response, sector
            ) values (?,?,?,?,?,?,?,?,?,?)""",
            (
                org_id, o.counterparty_id, o.channel, o.rung.value, int(o.prefilled),
                o.template.value, _d(o.sent), int(o.responded), o.hours_to_response, o.sector,
            ),
        )

    def list_outcomes(self, org_id: str) -> list[AttemptOutcome]:
        rows = self._c.execute("select * from attempt_outcome where org_id = ? order by id", (org_id,))
        return [
            AttemptOutcome(
                counterparty_id=r["counterparty_id"],
                channel=r["channel"],
                rung=ContactRung(r["rung"]),
                prefilled=bool(r["prefilled"]),
                template=RequestTemplate(r["template"]),
                sent=date.fromisoformat(r["sent"]),
                responded=bool(r["responded"]),
                hours_to_response=r["hours_to_response"],
                sector=r["sector"],
            )
            for r in rows
        ]
