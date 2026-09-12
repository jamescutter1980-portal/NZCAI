# Data sources: how the portal talks to external APIs

Every external API and dataset is a **connector** under `src/lib/integrations/<id>/` built on the framework in `src/lib/integrations/framework.ts`. Each declares its access route, territory, licence, attribution, required environment variables, a health check and a set of operations with typed parameters. The portal renders all of that generically.

## Where to look

| Surface | Purpose |
|---|---|
| `/sources` | Every source grouped as in the roadmap, with status, configuration state and a health check button. "Run all health checks" tests each configured source from your machine. |
| `/sources/<id>` | Source detail: notes, required keys and whether they are set, "Test connection", and one form per operation with results as a table, plain-English summary, provenance line and raw response. |
| `GET /api/sources` | Machine-readable list of the same. |
| `POST /api/sources/<id>/health` | Health check. |
| `POST /api/sources/<id>/ops/<op>` | Run an operation with JSON params. Returns `{ result }` or a structured error with the upstream status and body. |
| `pnpm sources:check` | CLI health check of all configured sources; `--all` includes unconfigured, `--id <id>` for one. Exit code 1 on failures. |

## Statuses

| Status | Meaning |
|---|---|
| Built, unverified | Connector and tests exist; built from documentation and open-source clients because the build environment cannot reach the service. Run the health check and one operation from your machine, then flip to live verified in the definition. |
| Live verified | Exercised against the live service. |
| Reference only | Access is by contract, registration, bulk download or GIS import. The entry carries the notes and links needed to obtain it; there is no client yet. |
| Planned | Identified, not started. |

## Configuration

Keys go in `.env.local` (never committed). Each source page lists its variables and whether they are set; the list page shows "needs X" until they are. Restart `pnpm dev` after editing `.env.local`.

Reference-data loaders (DESNZ factors, AIB residual mix, CRREM, NZCBS, sanctions, gender pay gap) read files under `data/reference/<id>/`; see `docs/integrations/reference-data.md` for filenames and columns.

## Provenance and attribution

Every operation result carries `provenance`: source id, dataset, basis (measured, modelled, estimated, client-declared, unavailable, not applicable), licence, territory, attribution and retrieval time. The UI prints the attribution line under every result. Anything persisted from a source must carry the same fields, as the n3rgy readings do.

## Verifying on your machine

1. Copy `.env.example` to `.env.local` and add the keys you hold.
2. `pnpm dev`, open `/sources`, click "Run all health checks".
3. For each source you rely on, run one operation with a real input and compare against the provider's own site.
4. Record what you found in `docs/api-gap-analysis.md` and update the definition's `status` and `notes`.
