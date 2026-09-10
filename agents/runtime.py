"""The loop. Model turn, guarded tool calls, repeat until the model stops
or the turn budget runs out. Nothing here knows what any agent is for."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional

from api.handlers import Context
from api.serialize import to_json

from .fleet import AgentSpec
from .guard import Guard, ToolRefused, TraceRow
from .model import ModelClient, ToolCall
from .tools import build_tools

__all__ = ["RunResult", "run"]


@dataclass
class RunResult:
    agent: str
    final_text: str
    turns: int
    trace: list[TraceRow]
    proposal_ids: list[int] = field(default_factory=list)
    stopped_reason: str = "model finished"

    @property
    def refused(self) -> list[TraceRow]:
        return [t for t in self.trace if not t.allowed]


def run(agent: AgentSpec, ctx: Context, model: ModelClient, task: str, *,
        max_turns: int = 8, max_writes: Optional[int] = None) -> RunResult:
    tools = build_tools(agent.tools)
    guard = Guard({t.name: t for t in tools}, max_writes=max_writes if max_writes is not None else agent.max_writes)
    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
    proposal_ids: list[int] = []
    final_text = ""
    turns = 0
    reason = "model finished"
    while turns < max_turns:
        turns += 1
        turn = model.complete(system=agent.system, messages=messages, tools=[t.as_model_tool() for t in tools])
        final_text = turn.text or final_text
        if not turn.tool_calls:
            break
        messages.append({"role": "assistant", "content": turn.text, "tool_calls": [to_json(c) for c in turn.tool_calls]})
        results = []
        for call in turn.tool_calls:
            results.append({"tool_call_id": call.id, "name": call.name, "result": _execute(guard, ctx, agent, call, proposal_ids)})
        messages.append({"role": "user", "content": json.dumps(results, default=str)})
    else:
        reason = f"turn budget of {max_turns} reached"
    return RunResult(agent.name, final_text, turns, guard.trace, proposal_ids, reason)


def _execute(guard: Guard, ctx: Context, agent: AgentSpec, call: ToolCall, proposal_ids: list[int]) -> Any:
    try:
        spec = guard.check(call)
    except ToolRefused as e:
        return {"error": str(e)}
    args = dict(call.arguments)
    if spec.writes:
        args["_agent"] = agent.name
    try:
        result = spec.fn(ctx, args)
    except Exception as e:  # noqa: BLE001 - reported to the model, never raised through it
        guard.trace.append(TraceRow(call.name, call.arguments, False, f"tool failed: {e}"))
        return {"error": str(e)}
    guard.record(call, spec, result)
    if spec.writes and isinstance(result, dict) and "proposal_id" in result:
        proposal_ids.append(result["proposal_id"])
    return result
