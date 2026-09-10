"""What an agent needs from a model, and nothing more.

`ModelClient.complete` takes the system prompt, the conversation so far and
the tool specifications, and returns text plus zero or more tool calls. The
runtime does not care which model answered. `StubModel` replays a script so
the fleet is tested without a network; `AnthropicModel` and `OllamaModel`
are thin HTTP adapters on the standard library, following the routing
convention in the brief: local model over client data, hosted model only
for public-source work.
"""

from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional, Protocol

__all__ = ["ToolCall", "ModelTurn", "ModelClient", "StubModel", "AnthropicModel", "OllamaModel"]


@dataclass(frozen=True)
class ToolCall:
    name: str
    arguments: dict[str, Any]
    id: str = ""


@dataclass
class ModelTurn:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)


class ModelClient(Protocol):
    def complete(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelTurn: ...


class StubModel:
    """Replays scripted turns. When the script runs out it answers with text
    and no tool calls, which ends the run."""

    def __init__(self, turns: Iterable[ModelTurn] = ()):
        self._turns = list(turns)
        self.calls: list[dict[str, Any]] = []

    def complete(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelTurn:
        self.calls.append({"system": system, "messages": list(messages), "tools": [t["name"] for t in tools]})
        if self._turns:
            return self._turns.pop(0)
        return ModelTurn(text="done")


class AnthropicModel:
    """Messages API over urllib. Only for work that touches no client data."""

    def __init__(self, model: str = "claude-sonnet-5", api_key: Optional[str] = None,
                 base_url: str = "https://api.anthropic.com", max_tokens: int = 2048):
        self.model, self.max_tokens, self.base_url = model, max_tokens, base_url
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")

    def complete(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelTurn:
        body = {"model": self.model, "max_tokens": self.max_tokens, "system": system, "messages": messages,
                "tools": [{"name": t["name"], "description": t["description"], "input_schema": t["schema"]} for t in tools]}
        req = urllib.request.Request(
            f"{self.base_url}/v1/messages", data=json.dumps(body).encode(), method="POST",
            headers={"content-type": "application/json", "x-api-key": self.api_key, "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.loads(r.read())
        turn = ModelTurn()
        for block in out.get("content", []):
            if block.get("type") == "text":
                turn.text += block.get("text", "")
            elif block.get("type") == "tool_use":
                turn.tool_calls.append(ToolCall(block["name"], block.get("input") or {}, block.get("id", "")))
        return turn


class OllamaModel:
    """Local model over the Ollama chat API. The default for client data."""

    def __init__(self, model: str = "llama3.1", base_url: str = "http://127.0.0.1:11434"):
        self.model, self.base_url = model, base_url

    def complete(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelTurn:
        body = {"model": self.model, "stream": False,
                "messages": [{"role": "system", "content": system}] + [
                    {"role": m["role"], "content": m["content"] if isinstance(m["content"], str) else json.dumps(m["content"])}
                    for m in messages],
                "tools": [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["schema"]}} for t in tools]}
        req = urllib.request.Request(f"{self.base_url}/api/chat", data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as r:
            out = json.loads(r.read())
        msg = out.get("message", {})
        turn = ModelTurn(text=msg.get("content") or "")
        for i, call in enumerate(msg.get("tool_calls") or []):
            fn = call.get("function", {})
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                args = json.loads(args)
            turn.tool_calls.append(ToolCall(fn.get("name", ""), args, f"call_{i}"))
        return turn
