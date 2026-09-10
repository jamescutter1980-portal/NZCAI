# NZCAI

NZC and ESG AI App.

## MCP layer

`nzcai-mcp` exposes the app's domain calculations to MCP clients (Claude Desktop,
Claude Code, the portal itself) as tools. One image, two transports: a stdio
subprocess for local use, or a long-lived Streamable HTTP service for the portal.

### Layout

```
src/nzcai_mcp/
  config.py        environment -> Config, the only place env vars are read
  datasets.py      versioned reference data + provenance
  server.py        the only module that imports the MCP SDK
  tools/           pure calculations: no MCP, no I/O, unit tested directly
data/
  factors/         emission factor sets      (mounted read-only at /data)
  pathways/        decarbonisation pathways
```

The split matters: `tools/` holds arithmetic the web app or a batch job can import
without a server in the loop, and `server.py` is a thin adapter over it.

### Run it

HTTP, the shape the portal uses:

```bash
docker compose up --build
curl http://127.0.0.1:8080/healthz
```

The MCP endpoint is `http://127.0.0.1:8080/mcp`.

stdio, where the client spawns the container per session — point an MCP client at:

```json
{
  "mcpServers": {
    "nzcai": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--mount", "type=bind,src=/absolute/path/to/data,dst=/data,ro",
        "nzcai-mcp:dev"
      ]
    }
  }
}
```

`NZCAI_MCP_TRANSPORT` defaults to `stdio`, so that invocation needs no further
configuration. See `.env.example` for the full set of variables.

### Tools

| Tool | Returns |
| --- | --- |
| `calculate_carbon_intensity` | EUI (kWh/m²), emissions by fuel, and dual location-based / market-based Scope 2 intensities |
| `crrem_misalignment_year` | First year an asset exceeds a decarbonisation pathway, the year-by-year projection, and cumulative excess emissions |
| `list_reference_datasets` | The factor sets and pathways this server can apply, with their provenance |

### Reference data and provenance

Factor tables and pathways are **mounted, not baked into the image** — factors are
reissued annually and CRREM pathways are licensed data that must not ship in a
container. Each dataset carries a `provenance` block, and every result derived from
one repeats it:

```json
"provenance": {
  "dataset": "factors/example-uk",
  "source": "PLACEHOLDER — illustrative values only",
  "verified": false,
  "warning": "UNVERIFIED PLACEHOLDER DATA — not for client issue"
}
```

**The bundled datasets are placeholders.** The factor values are illustrative, and
`data/pathways/example-office-eu.json` is a synthetic straight line, not a CRREM
pathway. Replace both with the real exports and set `verified: true` before any
output reaches a client. Nothing in the code checks this for you — the warning
travelling with every result is the control.

Datasets are cached for the process lifetime, so restart the container after
editing one.

### Security posture

- Runs as an unprivileged user, read-only root filesystem, all capabilities dropped,
  `no-new-privileges`.
- `/data` is mounted read-only; dataset names arriving as tool arguments are matched
  against a strict pattern rather than joined onto a path.
- The HTTP port binds to loopback. DNS-rebinding protection is enabled by setting
  `NZCAI_MCP_ALLOWED_HOSTS`; leaving it unset turns the check off and logs a warning
  at startup.

**Not yet built:** the HTTP transport has no authentication of its own. Put a
reverse proxy or OAuth in front of it before it is reachable off the host, and add
per-tenant scoping before it serves more than one client's data.

### Development

```bash
uv venv .venv && uv pip install --python .venv -e '.[dev]'
.venv/bin/python -m pytest
```

To add a tool: write the pure function in `tools/`, unit test it, then register a
thin wrapper in `server.py`. Raise `CalculationError` or `DatasetError` for anything
the caller could correct — `server.py` converts those to `ToolError` so the message
reaches the model. Any other exception is treated as a crash and its text is
withheld from the client, which leaves the model unable to fix its own call.
