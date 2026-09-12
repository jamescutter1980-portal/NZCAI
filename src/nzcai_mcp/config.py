"""Runtime configuration, read from the environment.

Everything the container needs to know is passed in as an environment variable so
the same image runs unchanged on a laptop, in CI and on the portal host.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DATA_DIR = Path("/data")
VALID_TRANSPORTS = ("stdio", "http")


@dataclass(frozen=True)
class Config:
    transport: str
    host: str
    port: int
    data_dir: Path
    allowed_hosts: tuple[str, ...] = ()
    allowed_origins: tuple[str, ...] = ()
    auth_token: str | None = None
    allow_anonymous: bool = False

    @property
    def mcp_transport(self) -> str:
        """Transport name in the form the MCP SDK expects."""
        return "streamable-http" if self.transport == "http" else "stdio"


def load_config(env: dict[str, str] | None = None) -> Config:
    env = os.environ if env is None else env

    transport = env.get("NZCAI_MCP_TRANSPORT", "stdio").strip().lower()
    if transport not in VALID_TRANSPORTS:
        raise ValueError(
            f"NZCAI_MCP_TRANSPORT must be one of {', '.join(VALID_TRANSPORTS)}, got {transport!r}"
        )

    raw_port = env.get("NZCAI_MCP_PORT", "8080")
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ValueError(f"NZCAI_MCP_PORT must be an integer, got {raw_port!r}") from exc

    return Config(
        transport=transport,
        host=env.get("NZCAI_MCP_HOST", "0.0.0.0"),
        port=port,
        data_dir=Path(env.get("NZCAI_DATA_DIR", str(DEFAULT_DATA_DIR))),
        allowed_hosts=_split(env.get("NZCAI_MCP_ALLOWED_HOSTS", "")),
        allowed_origins=_split(env.get("NZCAI_MCP_ALLOWED_ORIGINS", "")),
        auth_token=_optional(env.get("NZCAI_MCP_AUTH_TOKEN")),
        allow_anonymous=_flag(env.get("NZCAI_MCP_ALLOW_ANONYMOUS")),
    )


def _split(raw: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in raw.split(",") if item.strip())


def _optional(raw: str | None) -> str | None:
    """An empty or whitespace-only variable counts as unset: compose writes an
    empty string for a variable that has no value, and that must not be mistaken
    for a (very short) token."""
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


def _flag(raw: str | None) -> bool:
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}
