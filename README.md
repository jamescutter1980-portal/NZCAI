# NZC Portal

Net zero carbon and ESG data portal. Next.js 16, TypeScript, zod, vitest.

- `docs/data-source-roadmap.md` – data source register, gap review and integration sequence
- `docs/integrations/n3rgy.md` – first connector: consent-based smart-meter data

## What exists

| Area | Routes | Notes |
|---|---|---|
| n3rgy connector | `/meters/n3rgy`, `/api/n3rgy/consumption`, `/api/n3rgy/status` | Ad-hoc pulls, server-side key |
| Consents | `/consents`, `/api/consents`, `/api/consents/{id}`, `/api/consents/{id}/verify` | Gate on all live retrieval |
| Sync | `/sync`, `/api/n3rgy/sync`, `pnpm n3rgy:sync` | Scheduled pull, gaps, expiry warnings, tariffs |
| Readings | `/readings`, `/api/readings`, `/api/readings/meters` | Daily totals, gaps, CSV, indicative cost |
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
```

Data files under `data/` and every `.env*` except `.env.example` are gitignored.
