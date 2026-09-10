"""The fence around tool calls.

Checked before any tool runs: the tool is on this agent's allowlist, the
arguments match the schema (required keys present, types right, nothing
extra), and the run has not exceeded its write budget. Every call, allowed
or refused, goes on the trace, which is what a reviewer reads when asking
why an agent did something.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .model import ToolCall
from .tools import ToolSpec

__all__ = ["Guard", "ToolRefused", "TraceRow"]

_TYPES = {"string": str, "number": (int, float), "integer": int, "boolean": bool, "array": list, "object": dict}


class ToolRefused(Exception):
    pass


@dataclass
class TraceRow:
    tool: str
    arguments: dict[str, Any]
    allowed: bool
    reason: str = ""
    result: Any = None


@dataclass
class Guard:
    tools: dict[str, ToolSpec]
    max_writes: int = 20
    writes: int = 0
    trace: list[TraceRow] = field(default_factory=list)

    def check(self, call: ToolCall) -> ToolSpec:
        spec = self.tools.get(call.name)
        if spec is None:
            self._refuse(call, f"tool {call.name!r} is not on this agent's allowlist")
        if spec.writes and self.writes >= self.max_writes:
            self._refuse(call, f"write budget of {self.max_writes} exhausted")
        self._validate(call, spec.schema)
        return spec

    def record(self, call: ToolCall, spec: ToolSpec, result: Any) -> None:
        if spec.writes:
            self.writes += 1
        self.trace.append(TraceRow(call.name, call.arguments, True, result=result))

    def _refuse(self, call: ToolCall, reason: str) -> None:
        self.trace.append(TraceRow(call.name, call.arguments, False, reason))
        raise ToolRefused(reason)

    def _validate(self, call: ToolCall, schema: dict[str, Any]) -> None:
        args = call.arguments
        if not isinstance(args, dict):
            self._refuse(call, "arguments must be an object")
        props = schema.get("properties", {})
        for k in schema.get("required", []):
            if k not in args:
                self._refuse(call, f"missing required argument {k!r}")
        for k, v in args.items():
            if k not in props:
                self._refuse(call, f"unexpected argument {k!r}")
            expected = props[k].get("type")
            if expected and expected in _TYPES and not isinstance(v, _TYPES[expected]):
                self._refuse(call, f"argument {k!r} must be {expected}")
            if expected == "number" and isinstance(v, bool):
                self._refuse(call, f"argument {k!r} must be number")
