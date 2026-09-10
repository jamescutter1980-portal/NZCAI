"""The tool catalogue.

Read tools return engine and store output verbatim. Write tools do one
thing: put a proposal in the review queue for a person. There is no tool
that writes a figure, moves an engagement or sends a message, so the
allowlist is a second fence, not the only one.

Every write tool's schema requires the evidence a reviewer needs to judge
it without re-reading the source: a snippet for an extraction, the
candidate and method for a match, the outstanding items for a draft.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from api.handlers import Context, handle
from api.serialize import to_json
from engines import plan as planning
from engines import validity
from engines.conflict import reported_vs_published
from engines.lifecycle import is_open
from engines.resolve import Candidate, resolve
from engines.types import RequestTemplate

__all__ = ["ToolSpec", "CATALOGUE", "build_tools"]

ToolFn = Callable[[Context, dict[str, Any]], Any]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    schema: dict[str, Any]
    fn: ToolFn
    writes: bool = False

    def as_model_tool(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "schema": self.schema}


def _obj(required: list[str], **props: dict) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


S = {"type": "string"}
N = {"type": "number"}
B = {"type": "boolean"}


# --- read tools ---------------------------------------------------------------

def _api(name: str, ctx: Context, params: dict, body: Optional[dict] = None) -> Any:
    status, payload = handle(name, ctx, {k: str(v) for k, v in params.items()}, body or {})
    if status >= 400:
        raise ValueError(payload.get("error", "request failed"))
    return payload


def list_counterparties(ctx: Context, a: dict) -> Any:
    return _api("list_counterparties", ctx, {"period": a.get("period", ctx.today.year)})


def get_dossier(ctx: Context, a: dict) -> Any:
    return _api("counterparty_dossier", ctx, {"id": a["counterparty_id"], "period": a.get("period", ctx.today.year)})


def get_inventory(ctx: Context, a: dict) -> Any:
    p = _api("inventory", ctx, {"period": a.get("period", ctx.today.year)})
    p.pop("figures", None)  # category rows are enough; a model has no use for raw figures
    return p


def get_plan(ctx: Context, a: dict) -> Any:
    return _api("plan", ctx, {"period": a.get("period", ctx.today.year)})


def list_documents(ctx: Context, a: dict) -> Any:
    params = {"counterparty_id": a["counterparty_id"]} if a.get("counterparty_id") else {}
    return _api("list_documents", ctx, params)


def document_validity(ctx: Context, a: dict) -> Any:
    docs = ctx.store.visible_documents(to_org_id=ctx.org_id)
    return {"lapsed": to_json(validity.lapsed(docs, ctx.today)),
            "status": {d.id: validity.status(d, ctx.today).value for d in docs}}


def get_engagement(ctx: Context, a: dict) -> Any:
    return _api("get_engagement", ctx, {"id": a["engagement_id"]})


def match_counterparty(ctx: Context, a: dict) -> Any:
    """Deterministic matching against this organisation's counterparties.
    The model sees the engine's answer; it does not do the matching."""
    candidates = [Candidate(c.id, c.name, c.company_number) for c in ctx.store.list_counterparties(ctx.org_id)]
    r = resolve(a["raw_name"], candidates, company_number=a.get("company_number"))
    return to_json(r)


def compare_values(ctx: Context, a: dict) -> Any:
    """Run the conflict detector; the engine decides whether it is a conflict."""
    c = reported_vs_published(a["subject"], float(a["reported"]), float(a["published"]),
                              reported_source=a["reported_source"], published_source=a["published_source"])
    return to_json(c) if c else {"conflict": None, "note": "within tolerance"}


def contact_policy(ctx: Context, a: dict) -> Any:
    """What the plan engine permits for this counterparty today."""
    cp = ctx.store.get_counterparty(ctx.org_id, a["counterparty_id"])
    outcomes = [o for o in ctx.store.list_outcomes(ctx.org_id) if o.counterparty_id == cp.id]
    last = max((o.sent for o in outcomes), default=None)
    engs = [e for e in ctx.store.list_engagements(ctx.org_id) if e.counterparty_id == cp.id and is_open(e.state)]
    step = None
    if engs and engs[0].deadline:
        step = planning.next_step(planning.build_schedule(engs[0].deadline), ctx.today)
    return to_json({"may_contact": planning.may_contact(last, ctx.today), "last_contacted": last,
                    "template": planning.template_for(cp, needs_product_footprints=bool(a.get("needs_pcf"))),
                    "next_step": step, "is_dominant": cp.is_dominant,
                    "may_be_asked_beyond_vsme": cp.may_be_asked_beyond_vsme})


# --- write tools: proposals only ----------------------------------------------

def _propose(ctx: Context, agent: str, kind: str, payload: dict, confidence: Optional[float]) -> dict:
    pid = ctx.store.save_proposal(ctx.org_id, agent=agent, kind=kind, payload=payload, confidence=confidence)
    return {"proposal_id": pid, "status": "pending", "note": "queued for a person to decide"}


def propose_match(ctx: Context, a: dict) -> Any:
    return _propose(ctx, a.pop("_agent"), "counterparty_match", a, a.get("confidence"))


def propose_extraction(ctx: Context, a: dict) -> Any:
    if not str(a.get("snippet", "")).strip():
        raise ValueError("an extraction must quote the snippet it was read from")
    return _propose(ctx, a.pop("_agent"), "document_extract", a, a.get("confidence"))


def propose_draft(ctx: Context, a: dict) -> Any:
    RequestTemplate(a["template"])  # must be a named template, never bespoke
    if a.get("attachments"):
        raise ValueError("drafts may not carry attachments")
    cp = ctx.store.get_counterparty(ctx.org_id, a["counterparty_id"])
    if a["template"] != RequestTemplate.VSME.value and not cp.may_be_asked_beyond_vsme:
        raise ValueError(f"{cp.name} may only be asked in the VSME template")
    return _propose(ctx, a.pop("_agent"), "outbound_draft", a, None)


def propose_conflict(ctx: Context, a: dict) -> Any:
    return _propose(ctx, a.pop("_agent"), "conflict_resolution", a, a.get("confidence"))


def propose_transition(ctx: Context, a: dict) -> Any:
    ctx.store.get_engagement(ctx.org_id, a["engagement_id"])
    return _propose(ctx, a.pop("_agent"), "engagement_transition", a, None)


def flag(ctx: Context, a: dict) -> Any:
    return _propose(ctx, a.pop("_agent"), "flag", a, None)


CATALOGUE: dict[str, ToolSpec] = {t.name: t for t in (
    ToolSpec("list_counterparties", "Counterparties in this organisation, ranked by tonnes, with engagement state.",
             _obj([], period={"type": "integer"}), list_counterparties),
    ToolSpec("get_dossier", "Everything known about one counterparty: figures, score, route, documents, audit.",
             _obj(["counterparty_id"], counterparty_id=S, period={"type": "integer"}), get_dossier),
    ToolSpec("get_inventory", "Inventory totals, quality rows and trajectory for a period.",
             _obj([], period={"type": "integer"}), get_inventory),
    ToolSpec("get_plan", "The engagement plan: scores, tiers, routes and next steps.",
             _obj([], period={"type": "integer"}), get_plan),
    ToolSpec("list_documents", "Documents this organisation may see, optionally for one counterparty.",
             _obj([], counterparty_id=S), list_documents),
    ToolSpec("document_validity", "Which documents have lapsed or are expiring, per the validity engine.",
             _obj([]), document_validity),
    ToolSpec("get_engagement", "One engagement with its schedule, next step and audit trail.",
             _obj(["engagement_id"], engagement_id=S), get_engagement),
    ToolSpec("match_counterparty", "Deterministic match of a raw name to a known counterparty, with confidence.",
             _obj(["raw_name"], raw_name=S, company_number=S), match_counterparty),
    ToolSpec("compare_values", "Run the reported-versus-published conflict detector on two values.",
             _obj(["subject", "reported", "published", "reported_source", "published_source"],
                  subject=S, reported=N, published=N, reported_source=S, published_source=S), compare_values),
    ToolSpec("contact_policy", "Whether and how a counterparty may be contacted today.",
             _obj(["counterparty_id"], counterparty_id=S, needs_pcf=B), contact_policy),
    ToolSpec("propose_match", "Propose that a raw name is a known counterparty. A person confirms.",
             _obj(["raw_name", "candidate_id", "confidence", "method"], raw_name=S, candidate_id=S, confidence=N, method=S, evidence=S),
             propose_match, writes=True),
    ToolSpec("propose_extraction", "Propose a value read from a document, quoting the snippet. A person confirms before it touches a figure.",
             _obj(["document_id", "field", "value", "snippet", "confidence"], document_id=S, field=S, value={}, snippet=S, confidence=N, unit=S),
             propose_extraction, writes=True),
    ToolSpec("propose_draft", "Draft an outbound request in a named template. A person approves before it is sent.",
             _obj(["counterparty_id", "template", "rung", "subject", "body", "outstanding"],
                  counterparty_id=S, template=S, rung=S, subject=S, body=S, outstanding={"type": "array", "items": S},
                  attachments={"type": "array", "items": S}), propose_draft, writes=True),
    ToolSpec("propose_conflict", "Propose how a detected conflict should be resolved, with the reason.",
             _obj(["subject", "proposed_resolution", "rationale"], subject=S, proposed_resolution=S, rationale=S, confidence=N),
             propose_conflict, writes=True),
    ToolSpec("propose_transition", "Propose moving an engagement to a new state, with the trigger. A person confirms.",
             _obj(["engagement_id", "to", "trigger"], engagement_id=S, to=S, trigger=S, evidence_id=S),
             propose_transition, writes=True),
    ToolSpec("flag", "Raise something for a person to look at: an expiry, a news item, an anomaly.",
             _obj(["subject", "detail"], subject=S, detail=S, counterparty_id=S, severity=S), flag, writes=True),
)}


def build_tools(names: frozenset[str]) -> list[ToolSpec]:
    unknown = names - CATALOGUE.keys()
    if unknown:
        raise KeyError(f"no such tools: {sorted(unknown)}")
    return [CATALOGUE[n] for n in CATALOGUE if n in names]
