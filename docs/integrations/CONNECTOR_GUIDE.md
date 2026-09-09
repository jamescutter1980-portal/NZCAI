# Connector guide

How to add an external data source to NZC Portal. Read `src/lib/integrations/framework.ts` and the exemplar `src/lib/integrations/postcodes-io/` first.

## Layout

```
src/lib/integrations/<id>/
  index.ts                 exports `definition` (defineIntegration)
  client.ts                optional: typed helpers if index.ts gets long
  __tests__/<id>.test.ts   vitest, fixture-driven, no network
  __tests__/fixtures/*.json
```

`<id>` is kebab-case and stable (it becomes `Provenance.source`). Register it in `src/lib/integrations/registry.ts`.

## Definition rules

- `access`, `territory`, `licence`, `attribution`, `docsUrl` must be accurate. The attribution string is what the UI shows under results; use the provider's required wording where one exists (OGL: "Contains public sector information licensed under the Open Government Licence v3.0." plus the publisher).
- `envVars` lists every key or credential. Never read `process.env` directly; use `ctx.env`.
- `status` is `built_unverified` for anything built here without a live call. Only flip to `live_verified` after a real run.
- `notes` carry caveats a user needs: rate limits, coverage gaps, what the data does not prove (a desktop screening is not a survey), and how to obtain access.
- `healthCheck` should be the cheapest real request that proves the key and host work. Use `simpleHealth` where a GET suffices.

## Operations

- Each operation is a task a portal user would recognise ("Flood warnings near a postcode"), not an endpoint name.
- Parameters use `ParamSpec`. Prefer `postcode`, `latitude`/`longitude`, `uprn`, `mpxn`, `date`, `select` types so the form renders helpfully. Give `placeholder` and `help`.
- `run` receives validated, coerced params. Use `fetchJson`/`fetchText` and `buildUrl` from the framework. Never call global `fetch`.
- Return `summary` (plain English, one or two sentences with the headline numbers), `columns` + `rows` (flat, human-readable keys), `raw` (the upstream payload, trimmed if huge), `provenance` via `makeProvenance` with an honest `basis` (`measured`, `modelled`, `estimated`, `client_declared`, `unavailable`, `not_applicable`), and `warnings` for anything the user must not over-read.
- Not-found is a result with empty rows and `basis: "unavailable"`, not an exception. Auth failures and 5xx should throw (`IntegrationHttpError`) so the UI can show the upstream status.
- Cap result sizes (page size ≤ 100) and pass timeouts.

## Tests

- Use `testContext` and `runOperation` from `src/lib/integrations/testing.ts`; inject `fetch` with `routedFetch` or `vi.fn`.
- Fixtures should mirror the documented response shape. Where the shape came from documentation rather than a live call, say so in a comment at the top of the fixture's test.
- Cover: the URL and headers built (key placement), a happy path with row mapping, a not-found or empty path, and a validation failure that never hits the network.

## Reference-only sources

Commercial, contract-gated or bulk-download sources still get a definition with `status: "reference_only"`, no operations (or a single operation that returns links), full `notes` on how to obtain access and what the portal would do with the data. This keeps the gap analysis and the UI complete.
