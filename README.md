# NZC Portal

Net zero carbon and ESG data portal. Next.js 16, TypeScript, zod, vitest.

- `docs/data-source-roadmap.md` – data source register, gap review and integration sequence
- `docs/assets-and-carbon.md` – assets, meter linking, screening profile and carbon method
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
| Transport | `/transport`, `/api/transport/...`, `/api/factors` | Fleet, grey fleet, travel and commuting against picked DESNZ rows; DVLA and MOT vehicle lookup |
| Exports | `/api/exports/[kind]` | Readings, asset carbon, portfolio energy and carbon, SECR summary, consents |
| Assessment | `/api/assets/[id]/assessment` | CRREM misalignment year and UK NZCBS indicative check |
| Portfolio | `/portfolio`, `/api/portfolio` | Roll-up by calendar, financial or rolling-12-month period with data-quality flags |
| Assets | `/assets`, `/assets/[id]`, `/api/assets/...`, `pnpm carbon:intensity` | Meters per building, Scope 1 and 2 with factor provenance, screening across 14 point-based sources |
| Data sources | `/sources`, `/sources/[id]`, `/lookup`, `/api/sources/...`, `pnpm sources:check` | 111 sources, 82 connectors, 253 operations, generic forms, health checks, one-click location lookup |
| Storage | `data/portal.sqlite` | Node built-in SQLite, migrations on open |
| Access | `src/proxy.ts` | Optional basic auth via `PORTAL_BASIC_AUTH` |

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
