# NZC Portal

Net zero carbon and ESG data portal. Next.js 16, TypeScript, zod, vitest.

`nzcai-mcp` (below) is a separate Python service in the same repository: it exposes the domain calculations to MCP clients.

- `docs/data-source-roadmap.md` – data source register, gap review and integration sequence
- `docs/assets-and-carbon.md` – assets, meter linking, screening profile and carbon method
- `docs/value-chain.md` – Scope 3 counterparties: the register, the engagement lifecycle, the annual report and ledger asks, allocation and tiers
- `docs/api-implementation-plan.md` – the plan to close the remaining API gaps, phased by what actually blocks each
- `docs/api-gap-analysis.md` – what is integrated, what changed versus the catalogue, what could not be built, verification plan
- `docs/integrations/data-sources.md` – the sources pages, API routes and health-check CLI
- `docs/integrations/CONNECTOR_GUIDE.md` – how to add a connector
- `docs/integrations/reference-data.md` – files the factor and pathway loaders expect
- `docs/integrations/n3rgy.md` – first connector: consent-based smart-meter data

## What exists

| Area | Routes | Notes |
|---|---|---|
| n3rgy connector | `/meters/n3rgy`, `/api/n3rgy/consumption`, `/api/n3rgy/status` | Ad-hoc pulls, server-side key |
| Consents | `/consents`, `/api/consents`, `/api/consents/{id}`, `/api/consents/{id}/verify` | Gate on all live retrieval |
| Sync | `/sync`, `/api/n3rgy/sync`, `pnpm n3rgy:sync` | Scheduled pull, gaps, expiry warnings, tariffs |
| Readings | `/readings`, `/api/readings`, `/api/readings/meters` | Daily totals, gaps, CSV, indicative cost |
| Import | `src/lib/import`, `CsvImport` | Delimiter and preamble detection, column mapping, UK date and number parsing, all-or-nothing commit |
| Emissions | `/emissions`, `/api/emissions/...` | Refrigerants, water and waste against picked DESNZ rows, with landfill diversion |
| Value chain | `/value-chain`, `/value-chain/[id]`, `/value-chain/inbox`, `/api/value-chain/...` | Upstream and downstream counterparties, engagement lifecycle with audit trail, annual GHG report or activity ledger per counterparty, disclosed tier D spend fallback, attributable tCO2e with data quality tier, ranked chase plan, waves, Companies House resolution; inbound requests answered from the portal's figures with a consistency guard and roll-forward |
| Scope 3 analysis | `/value-chain/trend`, `/value-chain/completeness`, `/value-chain/hotspots`, `/value-chain/targets`, `/value-chain/submit/[token]` | Headline versus like-for-like change with baseline and restatements, all fifteen categories assessed with justified exclusions, spend-based hotspot screen that never feeds a reported total, targets against a straight-line trajectory with an abatement pipeline never netted off, and one-time hashed links for counterparties to submit their own report for review |
| Transport | `/transport`, `/api/transport/...`, `/api/factors` | Fleet, grey fleet, travel and commuting against picked DESNZ rows; DVLA and MOT vehicle lookup |
| Exports | `/api/exports/[kind]` | Readings, asset carbon, portfolio energy and carbon, SECR summary, consents, value chain |
| Assessment | `/api/assets/[id]/assessment` | CRREM misalignment year and UK NZCBS indicative check |
| Readiness | `/readiness`, `/api/readiness` | 24 checks graded blocker, gap or advisory before a return is filed |
| Portfolio | `/portfolio`, `/api/portfolio` | Roll-up by calendar, financial or rolling-12-month period with data-quality flags |
| Assets | `/assets`, `/assets/[id]`, `/api/assets/...`, `pnpm carbon:intensity` | Meters per building, Scope 1 and 2 with factor provenance, screening across 14 point-based sources |
| Data sources | `/sources`, `/sources/[id]`, `/lookup`, `/api/sources/...`, `pnpm sources:check` | 111 sources, 82 connectors, 253 operations, generic forms, health checks, one-click location lookup |
| Storage | `data/portal.sqlite` | Node built-in SQLite, migrations on open |
| Access | `src/proxy.ts` | Optional basic auth via `PORTAL_BASIC_AUTH` |
| CI | `.github/workflows/ci.yml` | Typecheck, lint, 791 portal tests and a build; 33 MCP-layer tests against an installed wheel |

## Develop

```
pnpm install
cp .env.example .env.local   # add keys
pnpm dev                     # http://localhost:3000
pnpm test
pnpm typecheck
pnpm lint
pnpm n3rgy:sync              # pull readings for active consents
pnpm sources:check --all     # health-check every data source from this machine
pnpm seed:demo               # fill an empty database with a worked Scope 3 example
```

Data files under `data/` and every `.env*` except `.env.example` are gitignored.

`pnpm seed:demo` writes a worked example, Harbourside Foods Ltd: fifteen
counterparties across both directions, two reporting years, a baseline and a
restatement, all fifteen categories assessed, two targets and five initiatives,
and one open supplier link. It is built around the awkward cases — a
counterparty rebased from spend to its own report, one that joined and one that
left, one that cannot be screened at all — so the value chain pages show what
they are for. It refuses to write to a database that already holds
counterparties unless `--reset` is passed.

Every push to `main` and every pull request runs `.github/workflows/ci.yml`:
typecheck, lint, the vitest suite and a production build for the portal, and
the pytest suite against an installed `nzcai-mcp` wheel. No secrets are
needed; both jobs are offline.

### Branch protection

CI runs on every pull request, but running is not the same as blocking: until
`main` is protected, a red pull request can still be merged. The intended rule,
set under **Settings → Rules → Rulesets** (repository admin only, so it lives
here as a record rather than as code):

| Setting | Value |
|---|---|
| Target | Default branch (`main`) |
| Enforcement | Active |
| Require status checks to pass | `Portal`, `MCP layer` |
| Require branches to be up to date before merging | on |
| Require a pull request before merging | on (approvals may be 0 while the team is small) |
| Block force pushes | on |
| Restrict deletions | off, so merged branches can still be tidied up |

The required checks are named for the **jobs** in `ci.yml`, not the workflow, so
they are `Portal` and `MCP layer` rather than `CI`. Renaming a job in the
workflow silently stops the old name from ever reporting, and a rule waiting on
a check that no longer exists blocks every merge: change both together.

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
