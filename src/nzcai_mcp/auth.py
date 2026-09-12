"""Bearer token authentication for the HTTP transport.

A shared secret in an ``Authorization: Bearer`` header, matching how the portal
guards its sync route with ``SYNC_TOKEN`` (``src/proxy.ts``). The stdio transport
is never checked: the client spawns the process directly, so there is no network
surface to guard and no place to put a credential.

Deliberately simple, and deliberately not OAuth. There is no identity provider in
this project, every deployment serves one client (``CLIENT_NAME``), and a token
either reaches every tool or none. When per-user identity arrives, this is the
seam to replace -- the SDK exposes ``token_verifier``/``auth`` hooks for it.
"""

from __future__ import annotations

import hmac
import logging
from collections.abc import Awaitable, Callable, Iterable

logger = logging.getLogger(__name__)

# Long enough that guessing is hopeless: the portal issues 32 random bytes for
# supplier links, so the MCP token is held to the same bar.
MIN_TOKEN_LENGTH = 32

# The container healthcheck runs with no credential, so liveness stays open. It
# reveals only that the server is up and its version.
DEFAULT_EXEMPT_PATHS = frozenset({"/healthz"})

Scope = dict
Receive = Callable[[], Awaitable[dict]]
Send = Callable[[dict], Awaitable[None]]


class AuthConfigError(ValueError):
    """Raised at startup when the auth configuration cannot be honoured."""


def validate_auth_config(transport: str, token: str | None, allow_anonymous: bool) -> None:
    """Refuse to start rather than silently serving an open endpoint.

    The portal leaves its sync route open when SYNC_TOKEN is unset, which is
    defensible for a UI whose front page would visibly be unprotected. An MCP
    endpoint is machine-to-machine: nobody would notice. So HTTP demands either a
    token or an explicit, deliberate opt-out.
    """
    if token is not None and len(token) < MIN_TOKEN_LENGTH:
        raise AuthConfigError(
            f"NZCAI_MCP_AUTH_TOKEN must be at least {MIN_TOKEN_LENGTH} characters, "
            f"got {len(token)}; generate one with: python -c "
            '"import secrets; print(secrets.token_urlsafe(32))"'
        )

    if transport != "http":
        return

    if token is None and not allow_anonymous:
        raise AuthConfigError(
            "the HTTP transport refuses to start unauthenticated: set "
            "NZCAI_MCP_AUTH_TOKEN, or set NZCAI_MCP_ALLOW_ANONYMOUS=true if this "
            "port is genuinely confined to a trusted network"
        )

    if token is None:
        logger.warning(
            "NZCAI_MCP_ALLOW_ANONYMOUS is set: the MCP endpoint accepts unauthenticated "
            "requests. Every tool is reachable by anything that can open the port."
        )


class BearerTokenMiddleware:
    """ASGI middleware enforcing a single shared bearer token."""

    def __init__(self, app, token: str, exempt_paths: Iterable[str] = DEFAULT_EXEMPT_PATHS):
        self.app = app
        self._token = token
        self._exempt = frozenset(exempt_paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Lifespan and any non-HTTP scope carry no credential and no request.
        if scope["type"] != "http" or scope.get("path") in self._exempt:
            await self.app(scope, receive, send)
            return

        presented = _bearer_credential(scope)
        if presented is None:
            await _challenge(send, "authentication required")
            return
        # compare_digest over the encoded bytes: constant time, and it cannot
        # raise on a non-ASCII token the way the str form can.
        if not hmac.compare_digest(presented.encode("utf-8"), self._token.encode("utf-8")):
            logger.warning("rejected a request bearing an invalid token")
            await _challenge(send, "invalid token", error="invalid_token")
            return

        await self.app(scope, receive, send)


def _bearer_credential(scope: Scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name.lower() != b"authorization":
            continue
        try:
            header = value.decode("latin-1")
        except UnicodeDecodeError:
            return None
        scheme, _, credential = header.partition(" ")
        if scheme.lower() != "bearer" or not credential.strip():
            return None
        return credential.strip()
    return None


async def _challenge(send: Send, detail: str, error: str | None = None) -> None:
    """RFC 6750 401: the challenge names the scheme, and an invalid token is
    distinguished from a missing one so a caller can tell the two apart."""
    challenge = 'Bearer realm="nzcai-mcp"'
    if error is not None:
        challenge += f', error="{error}"'
    body = f'{{"error":"unauthorized","detail":"{detail}"}}'.encode()
    await send(
        {
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"www-authenticate", challenge.encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
