"""Auth layer: startup validation, and the middleware as the wired app sees it."""

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from nzcai_mcp.auth import MIN_TOKEN_LENGTH, AuthConfigError, validate_auth_config
from nzcai_mcp.config import Config, load_config
from nzcai_mcp.server import build_http_app

REPO_DATA = Path(__file__).resolve().parent.parent / "data"
TOKEN = "t" * MIN_TOKEN_LENGTH


def make_config(**overrides) -> Config:
    base = dict(
        transport="http",
        host="127.0.0.1",
        port=8080,
        data_dir=REPO_DATA,
        # TestClient sends "Host: testserver"; the SDK auto-protects a loopback
        # bind, so the allowlist is configured rather than the protection disabled.
        allowed_hosts=("testserver",),
        allowed_origins=(),
        auth_token=TOKEN,
        allow_anonymous=False,
    )
    return Config(**{**base, **overrides})


# --- startup validation ---------------------------------------------------


def test_http_refuses_to_start_without_a_token():
    """An open MCP endpoint is machine-to-machine: nobody would notice it."""
    with pytest.raises(AuthConfigError, match="refuses to start unauthenticated"):
        validate_auth_config("http", None, allow_anonymous=False)


def test_http_starts_unauthenticated_only_on_explicit_opt_out():
    validate_auth_config("http", None, allow_anonymous=True)


def test_stdio_needs_no_token():
    """The client spawns the process; there is no network surface to guard."""
    validate_auth_config("stdio", None, allow_anonymous=False)


@pytest.mark.parametrize("length", [1, MIN_TOKEN_LENGTH - 1])
def test_short_token_rejected(length):
    with pytest.raises(AuthConfigError, match="at least 32 characters"):
        validate_auth_config("http", "t" * length, allow_anonymous=False)


def test_short_token_rejected_on_stdio_too():
    """A weak token is a mistake worth reporting whichever transport is in use."""
    with pytest.raises(AuthConfigError, match="at least 32 characters"):
        validate_auth_config("stdio", "short", allow_anonymous=False)


def test_blank_env_var_reads_as_unset_not_as_a_short_token():
    """Compose writes an empty string for a variable with no value."""
    config = load_config({"NZCAI_MCP_AUTH_TOKEN": "   ", "NZCAI_MCP_TRANSPORT": "http"})
    assert config.auth_token is None


@pytest.mark.parametrize("raw,expected", [("true", True), ("1", True), ("YES", True),
                                          ("false", False), ("", False), ("maybe", False)])
def test_allow_anonymous_flag_parsing(raw, expected):
    assert load_config({"NZCAI_MCP_ALLOW_ANONYMOUS": raw}).allow_anonymous is expected


# --- the middleware, through the fully wired app --------------------------


@pytest.fixture
def client():
    with TestClient(build_http_app(make_config())) as c:
        yield c


MCP_HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
               "clientInfo": {"name": "test", "version": "1"}},
}


def test_no_credential_is_challenged(client):
    res = client.post("/mcp", json=INITIALIZE, headers=MCP_HEADERS)
    assert res.status_code == 401
    assert res.headers["www-authenticate"].startswith('Bearer realm="nzcai-mcp"')
    assert "error" not in res.headers["www-authenticate"]


def test_wrong_token_is_distinguished_from_a_missing_one(client):
    res = client.post("/mcp", json=INITIALIZE,
                      headers={**MCP_HEADERS, "Authorization": f"Bearer {'x' * MIN_TOKEN_LENGTH}"})
    assert res.status_code == 401
    assert 'error="invalid_token"' in res.headers["www-authenticate"]


def test_correct_token_reaches_the_server(client):
    res = client.post("/mcp", json=INITIALIZE,
                      headers={**MCP_HEADERS, "Authorization": f"Bearer {TOKEN}"})
    assert res.status_code == 200


@pytest.mark.parametrize("header", [
    "",                       # empty
    "Bearer",                 # scheme with no credential
    "Bearer ",                # scheme with blank credential
    f"Basic {TOKEN}",         # wrong scheme
    TOKEN,                    # bare token, no scheme
])
def test_malformed_authorization_headers_are_rejected(client, header):
    res = client.post("/mcp", json=INITIALIZE, headers={**MCP_HEADERS, "Authorization": header})
    assert res.status_code == 401


def test_bearer_scheme_is_case_insensitive(client):
    """RFC 7235 makes the scheme token case-insensitive; some clients send 'bearer'."""
    res = client.post("/mcp", json=INITIALIZE,
                      headers={**MCP_HEADERS, "Authorization": f"bearer {TOKEN}"})
    assert res.status_code == 200


def test_a_token_that_is_a_prefix_of_the_real_one_is_rejected(client):
    res = client.post("/mcp", json=INITIALIZE,
                      headers={**MCP_HEADERS, "Authorization": f"Bearer {TOKEN[:-1]}"})
    assert res.status_code == 401


def test_healthz_stays_open_so_the_container_healthcheck_works(client):
    """The healthcheck runs inside the container with no credential to present."""
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_healthz_reveals_nothing_but_liveness(client):
    assert set(client.get("/healthz").json()) == {"status", "server", "version"}


def test_anonymous_app_is_not_wrapped():
    with TestClient(build_http_app(make_config(auth_token=None, allow_anonymous=True))) as c:
        assert c.post("/mcp", json=INITIALIZE, headers=MCP_HEADERS).status_code == 200
