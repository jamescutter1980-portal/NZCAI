"""The agent fleet: narrow jobs, explicit tools, proposals only.

Principle P7 of the Layer 2 brief, enforced in code rather than in a
prompt: agents find, read, classify, draft, rank and flag. The engines
compute every number. A person approves anything that changes a figure or
leaves the building.

    model.py    ModelClient protocol, StubModel for tests, thin HTTP adapters
    tools.py    the tool catalogue, every write a proposal into the review queue
    guard.py    allowlist, payload validation, write caps, a trace of every call
    runtime.py  the loop: model turn, guarded tool calls, stop
    fleet.py    the named agents and their deterministic preparation steps

The grep test in tests/test_agents.py holds this package to the rule: no
module here may call save_figures, supersede_figure or
transition_engagement, and no engine may import from here.
"""

from .fleet import AGENTS, AgentSpec
from .guard import Guard, ToolRefused
from .model import ModelClient, ModelTurn, StubModel, ToolCall
from .runtime import RunResult, run

__all__ = ["AGENTS", "AgentSpec", "Guard", "ToolRefused", "ModelClient", "ModelTurn",
           "StubModel", "ToolCall", "RunResult", "run"]
