import pytest

from nzcai_mcp.config import load_config


def test_defaults_to_stdio():
    config = load_config({})
    assert config.transport == "stdio"
    assert config.mcp_transport == "stdio"
    assert str(config.data_dir) == "/data"


def test_http_transport_maps_to_streamable_http():
    config = load_config({"NZCAI_MCP_TRANSPORT": "HTTP", "NZCAI_MCP_PORT": "9000"})
    assert config.mcp_transport == "streamable-http"
    assert config.port == 9000


def test_unknown_transport_rejected():
    with pytest.raises(ValueError, match="NZCAI_MCP_TRANSPORT"):
        load_config({"NZCAI_MCP_TRANSPORT": "grpc"})


def test_non_numeric_port_rejected():
    with pytest.raises(ValueError, match="NZCAI_MCP_PORT"):
        load_config({"NZCAI_MCP_PORT": "eighty"})


def test_allowed_hosts_parsed_as_list():
    config = load_config({"NZCAI_MCP_ALLOWED_HOSTS": "mcp.example.com, localhost:* ,"})
    assert config.allowed_hosts == ("mcp.example.com", "localhost:*")
