"""The named agents. Layer 2 brief section 10.

Each has a job, a system prompt, an allowlist, a write budget, and a
`prepare` step that gathers its input deterministically before any model
is involved. Much of each agent's work happens in `prepare`: the Watcher
finds lapsed documents with the validity engine, the Scoper computes
what is outstanding from the store, the Resolver runs the matcher. The
model is asked to judge, draft or explain what the engines found, and to
put its conclusions in the review queue.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from api.handlers import Context
from api.serialize import to_json
from engines import validity
from engines.lifecycle import is_open
from engines.resolve import Candidate, resolve
from engines.types import EngagementState as S

__all__ = ["AgentSpec", "AGENTS", "READ_TOOLS"]

Prepare = Callable[[Context, dict[str, Any]], str]

READ_TOOLS: frozenset[str] = frozenset({
    "list_counterparties", "get_dossier", "get_inventory", "get_plan", "list_documents",
    "document_validity", "get_engagement", "match_counterparty", "compare_values", "contact_policy",
})

_COMMON = """You work inside NZC AI, a Scope 3 engagement system for a regulated carbon consultancy.
Rules that are enforced by the tools and that you must also follow:
- You never compute, round, estimate or fill in an emissions figure. The engines do that.
- Anything you want to change goes through a propose_* tool and waits for a person.
- Quote the evidence for every proposal: the snippet, the candidate, the rule.
- If the tools do not give you enough to be confident, say so and stop. Do not guess.
- Client data is confidential. Do not restate it beyond what the task needs."""


@dataclass(frozen=True)
class AgentSpec:
    name: str
    job: str
    tools: frozenset[str]
    prepare: Prepare
    max_writes: int = 10
    #: "local" agents run over client data on the local model; "hosted" agents
    #: touch only public sources and may use the hosted API.
    routing: str = "local"
    extra_prompt: str = ""

    @property
    def system(self) -> str:
        return f"{_COMMON}\n\nYour job: {self.job}\n{self.extra_prompt}".strip()


# --- prepare steps: deterministic, engine-backed -----------------------------

def _prep_resolver(ctx: Context, inp: dict[str, Any]) -> str:
    names = inp.get("raw_names") or []
    candidates = [Candidate(c.id, c.name, c.company_number) for c in ctx.store.list_counterparties(ctx.org_id)]
    rows = [to_json(resolve(n, candidates)) for n in names]
    exact = [r for r in rows if r["candidate"] and not r["needs_review"]]
    review = [r for r in rows if r["candidate"] and r["needs_review"]]
    none = [r for r in rows if not r["candidate"]]
    return json.dumps({"instruction": "Exact matches need no proposal. For each review item decide whether to propose the "
                                      "candidate, citing the method and evidence. For unmatched names say what you would need.",
                       "exact": exact, "review": review, "unmatched": none})


def _prep_enricher(ctx: Context, inp: dict[str, Any]) -> str:
    cp = ctx.store.get_counterparty(ctx.org_id, inp["counterparty_id"])
    docs = [d for d in ctx.store.visible_documents(to_org_id=ctx.org_id) if d.counterparty_id == cp.id]
    return json.dumps({"instruction": "List what public disclosures this counterparty is likely to have (annual report, CDP, "
                                      "SBTi entry, EPDs) that are not already held, and flag each as a document to fetch. "
                                      "Do not extract figures; the Reader does that once a document is filed.",
                       "counterparty": to_json(cp), "held": to_json(docs)})


def _prep_scoper(ctx: Context, inp: dict[str, Any]) -> str:
    period = int(inp.get("period", ctx.today.year))
    figures = ctx.store.list_figures(ctx.org_id, period)
    needs = []
    for cp in ctx.store.list_counterparties(ctx.org_id):
        mine = [f for f in figures if f.counterparty_id == cp.id]
        gap = [f for f in mine if f.achievable_tier and f.achievable_tier.value < f.tier.value]
        if gap:
            needs.append({"counterparty_id": cp.id, "name": cp.name, "figures_below_achievable": len(gap),
                          "tonnes": sum(f.tco2e for f in gap), "categories": sorted({f.category.value for f in gap}),
                          "ask_in": "vsme" if not cp.may_be_asked_beyond_vsme else "ghg_category_or_pact"})
    needs.sort(key=lambda n: -n["tonnes"])
    return json.dumps({"instruction": "This is the outstanding data need per counterparty, computed by the engines. "
                                      "Summarise it as a data-need list in tonnes order. You write nothing.",
                       "needs": needs})


def _prep_chaser(ctx: Context, inp: dict[str, Any]) -> str:
    cp = ctx.store.get_counterparty(ctx.org_id, inp["counterparty_id"])
    engs = [e for e in ctx.store.list_engagements(ctx.org_id) if e.counterparty_id == cp.id and is_open(e.state)]
    return json.dumps({"instruction": "Check contact_policy first. If contact is permitted and a next step is due, draft "
                                      "the message with propose_draft in the template the policy names, addressed to the "
                                      "rung the step names, listing exactly what is outstanding. No attachments.",
                       "counterparty": to_json(cp), "open_engagements": to_json(engs),
                       "outstanding": inp.get("outstanding", [])})


def _prep_reader(ctx: Context, inp: dict[str, Any]) -> str:
    return json.dumps({"instruction": "Classify the document text and propose one extraction per field you can read, "
                                      "each with the exact snippet and a confidence. Fields you cannot find are not "
                                      "proposed. Never infer a number that is not printed.",
                       "document_id": inp["document_id"], "counterparty_id": inp.get("counterparty_id"),
                       "text": inp["text"][:20_000]})


def _prep_reconciler(ctx: Context, inp: dict[str, Any]) -> str:
    return json.dumps({"instruction": "Run compare_values on each pair. Where the engine reports a conflict, propose a "
                                      "resolution with reasoning via propose_conflict. Where it does not, say so.",
                       "pairs": inp.get("pairs", [])})


def _prep_analyst(ctx: Context, inp: dict[str, Any]) -> str:
    return json.dumps({"instruction": "Answer the question from tool output only, citing which tool and field each "
                                      "statement comes from. You have no write tools.",
                       "question": inp["question"]})


def _prep_watcher(ctx: Context, inp: dict[str, Any]) -> str:
    docs = ctx.store.visible_documents(to_org_id=ctx.org_id)
    lapses = validity.lapsed(docs, ctx.today)
    expiring = [d.id for d in docs if validity.expires_within(d, ctx.today, 90) and d not in {l.document for l in lapses}]
    verified = [e for e in ctx.store.list_engagements(ctx.org_id) if e.state == S.VERIFIED]
    stale = []
    for e in verified:
        held = [d for d in docs if d.counterparty_id == e.counterparty_id and validity.status(d, ctx.today).value == "valid"]
        if not held:
            stale.append(e.id)
    return json.dumps({"instruction": "For each lapsed document raise a flag; for each verified engagement with no valid "
                                      "document behind it, propose the transition to lapsed with the trigger. Do not "
                                      "move anything yourself.",
                       "lapsed": to_json(lapses), "expiring_within_90_days": expiring,
                       "verified_without_valid_evidence": stale})


AGENTS: dict[str, AgentSpec] = {a.name: a for a in (
    AgentSpec("resolver", "match raw counterparty names from ledgers and activity data to legal entities, and propose matches for a person to confirm.",
              READ_TOOLS | {"propose_match"}, _prep_resolver, max_writes=50),
    AgentSpec("enricher", "find public disclosures for a counterparty and say which documents to fetch, so the request we send asks only for what is not already public.",
              READ_TOOLS | {"flag"}, _prep_enricher, routing="hosted",
              extra_prompt="You may reason about public sources only. You are never given client figures."),
    AgentSpec("scoper", "state, per counterparty, exactly what is still needed after enrichment.",
              READ_TOOLS, _prep_scoper, max_writes=0),
    AgentSpec("chaser", "decide whether a counterparty should be contacted now and draft the request in full context of what is outstanding.",
              READ_TOOLS | {"propose_draft"}, _prep_chaser, max_writes=3),
    AgentSpec("reader", "classify an inbound document and propose extractions with snippets and confidence.",
              READ_TOOLS | {"propose_extraction"}, _prep_reader, max_writes=40),
    AgentSpec("reconciler", "detect conflicts between values and propose a resolution with the reason.",
              READ_TOOLS | {"propose_conflict"}, _prep_reconciler),
    AgentSpec("analyst", "answer questions over engine output with citations.",
              READ_TOOLS, _prep_analyst, max_writes=0),
    AgentSpec("watcher", "monitor for lapsed evidence, expiring certificates and stale verifications, and raise them for review.",
              READ_TOOLS | {"flag", "propose_transition"}, _prep_watcher, max_writes=50, routing="hosted"),
)}
