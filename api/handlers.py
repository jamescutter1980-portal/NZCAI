"""Request handlers. Pure: context and inputs in, (status, payload) out.

Every handler is scoped to `ctx.org_id`. Nothing here computes a number
that an engine could compute; the handlers marshal, call, and serialise.

Reference: docs/product/nzc-ai-scope-3-engagement-brief.md section 11
(the Request Inbox and dossier views) and section 13 (data model).
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable, Optional

from engines import coverage as cov
from engines import plan as planning
from engines import quality
from engines.activity import calculate as calc_activity
from engines.factors import FactorLibrary
from engines.lifecycle import Engagement, InvalidTransition, is_open
from engines.partner import AllocationBasis, allocate, apply_footprint
from engines.score import assign_tiers, score_counterparty
from engines.screen import OrgProfile, screen as screen_categories
from engines.types import (
    Category, Confidentiality, Counterparty, DeclineReason, Document, DocumentType,
    EngagementState, Figure, RelationshipRole, Tier,
)
from ingest.activity import parse_activity_csv
from ingest.bill import parse_bill_text
from ingest.ledger import parse_ledger_csv
from ingest.pact import parse_pact
from ingest.vsme import parse_vsme
from store import NotFound, Store

from .serialize import to_json

__all__ = ["Context", "HttpError", "handle", "HANDLERS"]


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Context:
    """What a request carries besides its parameters."""

    store: Store
    org_id: str
    actor: str = "anonymous"
    today: date = field(default_factory=date.today)
    library: Optional[FactorLibrary] = None
    #: Enabled ingestion side effects. Off in tests that only parse.
    persist_ingested: bool = True

    @property
    def factors(self) -> FactorLibrary:
        if self.library is None:
            self.library = FactorLibrary.load()
        return self.library


Handler = Callable[[Context, dict[str, str], dict[str, Any]], tuple[int, Any]]
HANDLERS: dict[str, Handler] = {}


def route(name: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        HANDLERS[name] = fn
        return fn
    return deco


def handle(name: str, ctx: Context, params: dict[str, str], body: dict[str, Any]) -> tuple[int, Any]:
    """Dispatch by handler name. Store and engine errors become HTTP errors."""
    fn = HANDLERS.get(name)
    if fn is None:
        return 405 if name == "method_not_allowed" else 404, {"error": "no such route"}
    try:
        status, payload = fn(ctx, params, body)
        return status, to_json(payload)
    except HttpError as e:
        return e.status, {"error": e.message}
    except NotFound as e:
        return 404, {"error": str(e)}
    except InvalidTransition as e:
        return 409, {"error": str(e)}
    except (ValueError, KeyError, TypeError) as e:
        return 400, {"error": str(e)}


# --- helpers ------------------------------------------------------------------

def _int(params: dict, key: str, default: Optional[int] = None) -> int:
    raw = params.get(key)
    if raw is None or raw == "":
        if default is None:
            raise HttpError(400, f"{key} is required")
        return default
    try:
        return int(raw)
    except ValueError:
        raise HttpError(400, f"{key} must be an integer") from None


def _float(params: dict, key: str, default: float = 0.0) -> float:
    raw = params.get(key)
    if raw in (None, ""):
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        raise HttpError(400, f"{key} must be a number") from None


def _bool(params: dict, key: str, default: bool = False) -> bool:
    raw = params.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).lower() in ("1", "true", "yes", "on")


def _date(raw: Optional[str]) -> Optional[date]:
    return date.fromisoformat(raw) if raw else None


def _enum(kind, raw, what: str):
    try:
        return kind(raw)
    except ValueError:
        raise HttpError(400, f"{what} {raw!r} is not one of {[k.value for k in kind]}") from None


def _counterparty_from(body: dict) -> Counterparty:
    if not body.get("id") or not body.get("name"):
        raise HttpError(400, "id and name are required")
    roles = frozenset(_enum(RelationshipRole, r, "role") for r in body.get("roles") or [])
    if not roles:
        raise HttpError(400, "at least one role is required")
    return Counterparty(
        id=body["id"], name=body["name"], roles=roles,
        company_number=body.get("company_number"), employee_band=body.get("employee_band"),
        turnover_gbp=body.get("turnover_gbp"),
        has_public_report=bool(body.get("has_public_report", False)),
        is_cdp_responder=bool(body.get("is_cdp_responder", False)),
        has_validated_target=bool(body.get("has_validated_target", False)),
        has_named_contact=bool(body.get("has_named_contact", False)),
        responded_before=bool(body.get("responded_before", False)),
        contractual_data_right=bool(body.get("contractual_data_right", False)),
        emissions_intensive_commodity=body.get("emissions_intensive_commodity"),
        contract_end=_date(body.get("contract_end")),
    )


def _figure_rows(ctx: Context, period: int) -> list[dict]:
    return [dict(id=fid, status=status, **to_json(f)) for fid, f, status in ctx.store.list_figure_rows(ctx.org_id, period)]


# --- inventory and quality ----------------------------------------------------

@route("health")
def health(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    return 200, {"ok": True, "org_id": ctx.org_id, "today": ctx.today}


@route("inventory")
def inventory(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    """The Scope 3 inventory for a period, with the ESRS E1-6 quality rows."""
    period = _int(params, "period", ctx.today.year)
    figures = ctx.store.list_figures(ctx.org_id, period)
    breakdown = quality.category_breakdown(figures)
    return 200, {
        "period": period,
        "total_tco2e": sum(f.tco2e for f in figures),
        "primary_share": quality.primary_share(figures) if figures else 0.0,
        "weighted_dq_score": quality.weighted_dq_score(figures) if figures else 0.0,
        "trajectory": quality.trajectory(figures) if figures else None,
        "categories": breakdown,
        "figures": _figure_rows(ctx, period),
    }


@route("figure_lineage")
def figure_lineage(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    chain = ctx.store.figure_lineage(ctx.org_id, _int(params, "id"))
    docs = {d.id: d for d in ctx.store.list_documents(ctx.org_id)}
    for row in chain:
        row["document"] = docs.get(row.get("document_id"))
    return 200, {"chain": chain}


@route("supersede_figure")
def supersede_figure(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    """A correction: a new figure that replaces the old one, which stays."""
    f = Figure(
        category=_enum(Category, str(body["category"]), "category"), tco2e=float(body["tco2e"]),
        tier=_enum(Tier, body["tier"], "tier"), factor_source=body["factor_source"],
        factor_version=body["factor_version"], counterparty_id=body.get("counterparty_id"),
        document_id=body.get("document_id"), entity_id=body.get("entity_id"),
        method_label=body.get("method_label"),
    )
    new_id = ctx.store.supersede_figure(ctx.org_id, _int(params, "id"), f, actor=ctx.actor)
    return 201, {"id": new_id, "supersedes": _int(params, "id")}


@route("coverage")
def coverage(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    """SBTi readiness. Covered categories default to every category with a
    figure, which is the optimistic reading; pass `covered` to narrow it."""
    period = _int(params, "period", ctx.today.year)
    figures = ctx.store.list_figures(ctx.org_id, period)
    if params.get("covered"):
        covered = frozenset(_enum(Category, c.strip(), "category") for c in params["covered"].split(",") if c.strip())
    else:
        covered = frozenset(f.category for f in figures)
    excluded = frozenset(_enum(Category, c.strip(), "category") for c in (params.get("excluded") or "").split(",") if c.strip())
    result = cov.assess(
        figures, scope1=_float(params, "scope1"), scope2=_float(params, "scope2"),
        covered_categories=covered, excluded_categories=excluded,
        sells_fossil_fuel=_bool(params, "sells_fossil_fuel"),
    )
    return 200, {"period": period, "covered": covered, "excluded": excluded, "result": result}


@route("screen")
def screen(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    profile = OrgProfile(
        employee_count=_int(params, "employee_count", 0),
        **{k: _bool(params, k, getattr(OrgProfile, k, False)) for k in (
            "sells_fossil_fuel", "has_fleet", "has_capital_projects", "leases_in", "leases_out",
            "is_franchisor", "sells_physical_products", "sold_products_use_energy",
            "sold_products_need_processing", "has_investments") if k in params},
    )
    return 200, {"categories": screen_categories(profile)}


# --- counterparties -----------------------------------------------------------

@route("list_counterparties")
def list_counterparties(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    period = _int(params, "period", ctx.today.year)
    engs = {e.counterparty_id: e for e in ctx.store.list_engagements(ctx.org_id, period=period)}
    tonnes: dict[str, float] = {}
    for f in ctx.store.list_figures(ctx.org_id, period):
        if f.counterparty_id:
            tonnes[f.counterparty_id] = tonnes.get(f.counterparty_id, 0.0) + f.tco2e
    rows = []
    for cp in ctx.store.list_counterparties(ctx.org_id):
        e = engs.get(cp.id)
        rows.append({**to_json(cp), "tco2e": tonnes.get(cp.id, 0.0),
                     "engagement": e, "open": is_open(e.state) if e else False})
    rows.sort(key=lambda r: -r["tco2e"])
    return 200, {"period": period, "counterparties": rows}


@route("create_counterparty")
def create_counterparty(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    cp = _counterparty_from(body)
    ctx.store.save_counterparty(ctx.org_id, cp)
    return 201, cp


@route("counterparty_dossier")
def counterparty_dossier(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    """Everything the portal knows about one counterparty, in one call."""
    cp = ctx.store.get_counterparty(ctx.org_id, params["id"])
    period = _int(params, "period", ctx.today.year)
    figures = [r for r in _figure_rows(ctx, period) if r["counterparty_id"] == cp.id]
    engagements = [e for e in ctx.store.list_engagements(ctx.org_id) if e.counterparty_id == cp.id]
    docs = [d for d in ctx.store.visible_documents(to_org_id=ctx.org_id) if d.counterparty_id == cp.id]
    uplift = sum(quality.uplift_tonnes(f) for f in ctx.store.list_figures(ctx.org_id, period) if f.counterparty_id == cp.id)
    score = score_counterparty(cp, uplift_tco2e=uplift, annual_spend_gbp=_float(params, "spend"), today=ctx.today)
    template = planning.template_for(cp, needs_product_footprints=_bool(params, "needs_pcf"))
    trails = {e.id: ctx.store.audit_trail(ctx.org_id, e.id) for e in engagements}
    return 200, {
        "counterparty": cp, "figures": figures, "tco2e": sum(r["tco2e"] for r in figures),
        "uplift_tco2e": uplift, "score": score, "template": template,
        "engagements": engagements, "audit": trails, "documents": docs,
    }


# --- the plan -----------------------------------------------------------------

@route("plan")
def plan(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    """Who to chase, in what order, by what route, and what is due next.

    Annual spend per counterparty is not in the store yet; pass it as a
    `spend` JSON object in the body or accept zero leverage from spend.
    """
    period = _int(params, "period", ctx.today.year)
    spend: dict[str, float] = body.get("spend") or {}
    figures = ctx.store.list_figures(ctx.org_id, period)
    uplift: dict[str, float] = {}
    for f in figures:
        if f.counterparty_id:
            uplift[f.counterparty_id] = uplift.get(f.counterparty_id, 0.0) + quality.uplift_tonnes(f)
    cps = ctx.store.list_counterparties(ctx.org_id)
    scores = [score_counterparty(cp, uplift_tco2e=uplift.get(cp.id, 0.0),
                                 annual_spend_gbp=float(spend.get(cp.id, 0.0)), today=ctx.today) for cp in cps]
    tiers = assign_tiers(scores) if scores else {}
    engs = {e.counterparty_id: e for e in ctx.store.list_engagements(ctx.org_id, period=period)}
    rows = []
    for cp, s in zip(cps, scores):
        e = engs.get(cp.id)
        step = None
        if e and e.deadline and is_open(e.state):
            step = planning.next_step(planning.build_schedule(e.deadline), ctx.today)
        rows.append({"counterparty": cp, "score": s, "tier": tiers.get(cp.id),
                     "template": planning.template_for(cp), "engagement": e, "next_step": step})
    rows.sort(key=lambda r: -r["score"].score)
    return 200, {"period": period, "rows": rows,
                 "total_uplift_tco2e": sum(uplift.values()),
                 "trajectory": quality.trajectory(figures) if figures else None}


# --- engagements --------------------------------------------------------------

@route("list_engagements")
def list_engagements(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    state = _enum(EngagementState, params["state"], "state") if params.get("state") else None
    period = _int(params, "period", 0) or None
    return 200, {"engagements": ctx.store.list_engagements(ctx.org_id, period=period, state=state)}


@route("create_engagement")
def create_engagement(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    for k in ("id", "counterparty_id", "period"):
        if not body.get(k):
            raise HttpError(400, f"{k} is required")
    ctx.store.get_counterparty(ctx.org_id, body["counterparty_id"])  # must exist in this org
    e = Engagement(id=body["id"], counterparty_id=body["counterparty_id"], period=int(body["period"]),
                   deadline=_date(body.get("deadline")))
    ctx.store.save_engagement(ctx.org_id, e)
    return 201, e


@route("get_engagement")
def get_engagement(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    e = ctx.store.get_engagement(ctx.org_id, params["id"])
    schedule = planning.build_schedule(e.deadline) if e.deadline else []
    return 200, {"engagement": e, "schedule": schedule,
                 "next_step": planning.next_step(schedule, ctx.today) if schedule and is_open(e.state) else None,
                 "audit": ctx.store.audit_trail(ctx.org_id, e.id)}


@route("transition_engagement")
def transition_engagement(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    if not body.get("to"):
        raise HttpError(400, "to is required")
    to = _enum(EngagementState, body["to"], "state")
    reason = _enum(DeclineReason, body["decline_reason"], "decline_reason") if body.get("decline_reason") else None
    moved, row = ctx.store.transition_engagement(
        ctx.org_id, params["id"], to, actor=ctx.actor, trigger=body.get("trigger") or "ui",
        at=_date(body.get("at")) or ctx.today, decline_reason=reason, evidence_id=body.get("evidence_id"),
    )
    return 200, {"engagement": moved, "audit_row": row}


@route("engagement_audit")
def engagement_audit(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    ctx.store.get_engagement(ctx.org_id, params["id"])
    return 200, {"audit": ctx.store.audit_trail(ctx.org_id, params["id"])}


# --- documents ----------------------------------------------------------------

@route("list_documents")
def list_documents(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    """Only what this organisation may see: its own, public, and consented."""
    docs = ctx.store.visible_documents(to_org_id=ctx.org_id)
    if params.get("counterparty_id"):
        docs = [d for d in docs if d.counterparty_id == params["counterparty_id"]]
    return 200, {"documents": docs}


@route("create_document")
def create_document(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    for k in ("id", "counterparty_id", "doc_type", "issue_date"):
        if not body.get(k):
            raise HttpError(400, f"{k} is required")
    d = Document(
        id=body["id"], counterparty_id=body["counterparty_id"],
        doc_type=_enum(DocumentType, body["doc_type"], "doc_type"),
        issue_date=_date(body["issue_date"]),
        confidentiality=_enum(Confidentiality, body.get("confidentiality", "client_only"), "confidentiality"),
        period_covered=body.get("period_covered"), valid_to=_date(body.get("valid_to")),
        owner_org_id=ctx.org_id, consented_org_ids=frozenset(body.get("consented_org_ids") or []),
        storage_key=body.get("storage_key"), sha256=body.get("sha256"),
    )
    ctx.store.save_document(ctx.org_id, d)
    return 201, d


# --- review queue -------------------------------------------------------------

@route("review_queue")
def review_queue(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    return 200, {"proposals": ctx.store.list_proposals(ctx.org_id),
                 "conflicts": ctx.store.list_conflicts(ctx.org_id)}


@route("decide_proposal")
def decide_proposal(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    if "accept" not in body:
        raise HttpError(400, "accept is required")
    p = ctx.store.decide_proposal(ctx.org_id, _int(params, "id"), accept=bool(body["accept"]), decided_by=ctx.actor)
    return 200, p


@route("decide_conflict")
def decide_conflict(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    if not body.get("decision"):
        raise HttpError(400, "decision is required")
    ctx.store.decide_conflict(ctx.org_id, _int(params, "id"), decision=body["decision"], decided_by=ctx.actor)
    return 200, {"id": _int(params, "id"), "decision": body["decision"]}


# --- ingestion ----------------------------------------------------------------

def _payload_bytes(body: dict) -> bytes:
    if "bytes_base64" in body:
        return base64.b64decode(body["bytes_base64"])
    if "text" in body:
        return str(body["text"]).encode()
    raise HttpError(400, "text or bytes_base64 is required")


@route("ingest")
def ingest(ctx: Context, params: dict, body: dict) -> tuple[int, Any]:
    """Parse, and where the parse yields figures or documents, persist them.

    kinds: ledger, activity, pact, vsme, bill. The response always carries
    the parser's errors; a partial batch is persisted only when `partial`
    is true, otherwise nothing is written if any row failed.
    """
    kind = params["kind"]
    period = _int(body, "period", ctx.today.year) if isinstance(body.get("period"), (int, str)) else ctx.today.year
    partial = bool(body.get("partial", False))
    written: dict[str, Any] = {}

    if kind == "ledger":
        r = parse_ledger_csv(_payload_bytes(body).decode(), source=body.get("source"), default_year=period)
        out: dict[str, Any] = {"lines": r.items}
    elif kind == "activity":
        r = parse_activity_csv(_payload_bytes(body).decode(), source=body.get("source"), library=ctx.factors)
        figures = [calc_activity(l, ctx.factors) for l in r.items]
        out = {"lines": r.items, "figures": figures}
        if ctx.persist_ingested and figures and (r.ok or partial):
            written["figure_ids"] = ctx.store.save_figures(ctx.org_id, period, figures, created_by=ctx.actor)
    elif kind == "pact":
        r = parse_pact(_payload_bytes(body), counterparty_id=body["counterparty_id"], owner_org_id=ctx.org_id,
                       confidentiality=_enum(Confidentiality, body.get("confidentiality", "client_only"), "confidentiality"))
        out = {"footprints": r.items}
        figures = []
        if body.get("quantity") is not None and body.get("unit"):
            figures = [apply_footprint(p.footprint, float(body["quantity"]), body["unit"]) for p in r.items]
            out["figures"] = figures
        if ctx.persist_ingested and r.items and (r.ok or partial):
            for p in r.items:
                ctx.store.save_document(ctx.org_id, p.document)
            written["document_ids"] = [p.document.id for p in r.items]
            if figures:
                written["figure_ids"] = ctx.store.save_figures(ctx.org_id, period, figures, created_by=ctx.actor)
    elif kind == "vsme":
        cp = ctx.store.get_counterparty(ctx.org_id, body["counterparty_id"])
        r = parse_vsme(_payload_bytes(body), counterparty_id=cp.id, counterparty_name=cp.name, period=period,
                       owner_org_id=ctx.org_id)
        out = {"returns": r.items}
        figures = []
        if body.get("our_share") is not None and r.items and r.items[0].complete_for_allocation:
            resp = r.items[0].to_partner_response(
                our_share=float(body["our_share"]),
                basis=_enum(AllocationBasis, body.get("basis", "revenue_share"), "basis"))
            figures = [allocate(resp)]
            out["figures"] = figures
        if ctx.persist_ingested and r.items:
            ctx.store.save_document(ctx.org_id, r.items[0].document)
            written["document_ids"] = [r.items[0].document.id]
            if figures:
                written["figure_ids"] = ctx.store.save_figures(ctx.org_id, period, figures, created_by=ctx.actor)
    elif kind == "bill":
        r = parse_bill_text(_payload_bytes(body).decode(), source=body.get("source"))
        out = {"bills": r.items}
        if r.items and r.items[0].usable and body.get("factor_key") and body.get("entity_id"):
            b = r.items[0]
            cat = _enum(Category, str(body["category"]), "category") if body.get("category") else None
            line = b.to_activity_line(factor_key=body["factor_key"], entity_id=body["entity_id"],
                                      document_id=body.get("document_id") or f"bill:{body['entity_id']}:{b.period_end}",
                                      counterparty_id=body.get("counterparty_id"), category=cat)
            fig = calc_activity(line, ctx.factors)
            out["figures"] = [fig]
            if ctx.persist_ingested:
                written["figure_ids"] = ctx.store.save_figures(ctx.org_id, period, [fig], created_by=ctx.actor)
    else:
        raise HttpError(404, f"no ingestion for {kind!r}")

    status = 200 if r.ok else 207
    return status, {"kind": kind, "ok": r.ok, "errors": r.errors, "written": written, **out}
