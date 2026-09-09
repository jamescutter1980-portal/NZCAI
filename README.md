# NZC Portal

Net zero carbon and ESG data portal. Next.js 16, TypeScript, zod, vitest.

- `docs/data-source-roadmap.md` – data source register, gap review and integration sequence
- `docs/integrations/n3rgy.md` – first connector: consent-based smart-meter data

## Develop

```
pnpm install
cp .env.example .env.local   # add keys
pnpm dev                     # http://localhost:3000
pnpm test
pnpm typecheck
pnpm lint
```
