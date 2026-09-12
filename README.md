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
```

Data files under `data/` and every `.env*` except `.env.example` are gitignored.

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
  reference.py     the DESNZ flat file loader (the portal's file, same rules)
  pathways.py      the CRREM pathway loader (likewise)
  uk_nzcbs.py      the UK NZCBS limit table loader (likewise)
  auth.py          bearer token middleware for the HTTP transport
  server.py        the only module that imports the MCP SDK
  tools/           pure calculations: no MCP, no I/O, unit tested directly
data/
  reference/       published tables, supplied per deployment (gitignored)
```

The split matters: `tools/` holds arithmetic the web app or a batch job can import
without a server in the loop, and `server.py` is a thin adapter over it.

### Run it

HTTP, the shape the portal uses:

```bash
# The HTTP transport will not start without a token -- see Authentication below.
echo "NZCAI_MCP_AUTH_TOKEN=$(python -c 'import secrets; print(secrets.token_urlsafe(32))')" >> .env
docker compose up --build
curl http://127.0.0.1:8080/healthz
```

The MCP endpoint is `http://127.0.0.1:8080/mcp`, and callers send
`Authorization: Bearer $NZCAI_MCP_AUTH_TOKEN`.

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
| `calculate_carbon_intensity` | EUI (kWh/m²), emissions by fuel, and dual location-based / market-based Scope 2 intensities, from the DESNZ factors for the reporting year |
| `search_emission_factors` | Rows of the loaded DESNZ flat file with their ids, so a fuel or activity can point at a published row |
| `crrem_misalignment_year` | First year an asset exceeds a CRREM pathway, the year-by-year projection, cumulative excess, and the caveats that apply |
| `nzcbs_limits` | UK NZCBS limits for a sector, optionally by year and metric, with rows the Standard sets no limit for flagged as unavailable |
| `nzcbs_check` | Indicative comparison of supplied building values against those limits — pass, fail, or not_assessable |
| `list_reference_datasets` | Which DESNZ years, CRREM versions and NZCBS versions are loaded, and what each covers |

### Emission factors

Factors come from the **DESNZ UK Government GHG Conversion Factors for Company
Reporting** — the same annual flat file the portal reads, in the same place, parsed
by the same rules. Nothing here holds its own copy of a factor value.

Supply the file once and both layers use it:

1. Download the *flat file for automatic processing* (XLSX) for the reporting year
   from the [DESNZ publication](https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2025).
2. Export the `Factors by Category` sheet to CSV (UTF-8). Leave the title rows; the
   loader finds the header by its first cell, `ID`.
3. Save it as `data/reference/desnz-conversion-factors/<year>.csv`.

`data/reference/` is gitignored: published tables are supplied per deployment and
never enter version control. `REFERENCE_DATA_DIR` overrides the location and is the
same variable the portal uses, so one setting configures both. Files are re-read when
their mtime or size changes — no restart needed.

Two rules the loader enforces, both inherited from the portal:

- **A blank factor means "not available" and is never read as 0.** DESNZ republished
  the 2026 flat file in July 2026 because unavailable factors had been shown as zero.
  A calculation that would consume one fails instead. A published `0` is a real zero.
- **Location-based Scope 2 is generation plus transmission & distribution.** The WTT
  rows are Scope 3 and are not included.

`electricity` and `natural_gas` resolve through the selectors the portal defines
(`src/lib/carbon/factors.ts`). Any other fuel is addressed by its published row id,
which `search_emission_factors` will find — no fuel's lookup text is guessed here.

Every result names the rows behind it:

```json
"provenance": {
  "source": "DESNZ UK Government GHG Conversion Factors for Company Reporting",
  "reporting_year": 2025,
  "file": "2025.csv",
  "factors": {
    "electricity": {
      "reference": "DESNZ 2025 row 1001, 2001 (2025.csv)",
      "rows": [{"id": "1001", "scope": "Scope 2", "description": "UK electricity / Electricity generated", "...": "..."}]
    }
  }
}
```

### CRREM pathways

Pathways load from `data/reference/crrem-pathways/<version>.csv` — the same files
the portal's `crrem-pathways` integration reads, with the same columns, the same
accepted scenario spellings (`1.5C`, `1.5`, `1,5C`, `1.5 °C`) and the same
treatment of a blank value. Export the pathway tables from the CRREM tool for the
release you use; the newest loaded version is the default.

**These are licensed, not open data.** Confirm software-use rights with CRREM
before pathway values reach a commercial tool or a client deliverable. Every result
carries CRREM's attribution and a `modelled` basis — these are science-based
targets, not measurements.

Three behaviours worth knowing, all inherited from the portal's method:

- **A single asset value is held constant** across the pathway years. That is a
  static projection — it ignores grid decarbonisation and planned measures — so it
  comes back with a warning saying so. For a CRREM-consistent answer, pass the
  projected series: `{"2025": 65, "2026": 63, ...}`.
- **A pathway year published without a value is skipped**, never read as zero, and
  reported as `no_pathway_value`.
- **Asset years outside the pathway are ignored** and named in the warnings.

Results always carry a reminder to check that the floor-area basis, scope and grid
factor assumptions match the pathway's, because a misalignment year computed on a
different basis is worse than none.

### UK NZCBS limits

Limits load from `data/reference/uk-nzcbs/<version>.csv`, transcribed from the
published Standard into the same files the portal's `uk-nzcbs` integration reads.
Like CRREM, the Standard is licensed material: results carry its attribution and
the reminder to verify against the current publication.

**`nzcbs_check` is indicative, not a compliance determination.** The Standard has
its own metering, verification and reporting method, and certification needs an
approved verifier. The tool says so on every result.

The rule that makes it worth having, inherited from the portal's assessment:

> No limit, benchmark or asset value is invented.

So a metric is reported `not_assessable`, **never a pass**, when either the file
sets no limit for it — a blank cell is the Standard setting none, not a limit of
zero — or you supplied no value for it. The portal computes operational energy
intensity from meter readings; this layer has no meters, so you pass the values you
have and everything else comes back not assessable with the reason.

Sector names match exactly first, then on a single unambiguous partial. Two
candidates is no match, because guessing which sector's limits apply is worse than
saying it cannot be determined.

### Authentication

The HTTP transport is guarded by a shared bearer token, the same shape as the
portal's `SYNC_TOKEN` (`src/proxy.ts`). Set it and callers must present it:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"   # into NZCAI_MCP_AUTH_TOKEN
curl -H "Authorization: Bearer $NZCAI_MCP_AUTH_TOKEN" http://127.0.0.1:8080/mcp
```

Three rules are worth knowing:

- **HTTP refuses to start without a token.** Unlike the portal, which serves its
  sync route openly when `SYNC_TOKEN` is unset, an unauthenticated MCP endpoint is
  machine-to-machine and nobody would notice it. Set `NZCAI_MCP_ALLOW_ANONYMOUS=true`
  to opt out deliberately for a port confined to a trusted network; it logs a warning.
- **stdio ignores the token entirely.** The client spawns the process, so there is
  no network surface to guard and nowhere to put a credential.
- **`/healthz` stays open**, because the container healthcheck has no credential to
  present. It reveals only that the server is up, and its version.

Comparison is constant-time, tokens under 32 characters are refused at startup, and
a wrong token is answered `401` with `error="invalid_token"` so a caller can tell it
apart from a missing one.

It is a shared secret, not identity: any holder reaches every tool. That suits the
current design — one deployment per client (`CLIENT_NAME`), read-only calculation
tools, no per-user data. Per-user identity means OAuth, and the SDK's
`token_verifier`/`auth` hooks are where it would go; `build_http_app` in `server.py`
is the seam.

### Security posture

- Runs as an unprivileged user, read-only root filesystem, all capabilities dropped,
  `no-new-privileges`.
- `/data` is mounted read-only; dataset names arriving as tool arguments are matched
  against a strict pattern rather than joined onto a path.
- DNS-rebinding protection: the SDK auto-protects a **loopback** bind, but applies
  no default to any other bind address. The container binds `0.0.0.0`, so
  `NZCAI_MCP_ALLOWED_HOSTS` is the only guard there — unset, it logs a warning.
- A bearer token on plain HTTP is readable in transit, so terminate TLS at a reverse
  proxy before the port leaves the host.

**Still not built:** per-tenant scoping. One token reaches everything, which is fine
while a deployment serves one client and the tools hold no client data.

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
