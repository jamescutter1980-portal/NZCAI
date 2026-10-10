# Client API keys

A client can pull their own portfolio data into their reporting stack
(Power BI, Excel, a data warehouse) on a schedule. Each client gets keys
that read only the assets assigned to them, through a fixed set of
read-only routes.

## What a key can read

| Route | Returns |
|---|---|
| `GET /api/assets` | The client's assets (internal notes removed) |
| `GET /api/assets/{id}` | One asset with its meters |
| `GET /api/assets/{id}/carbon?year=YYYY` | Scope 1, 2 and 3 T&D lines with factor provenance |
| `GET /api/assets/{id}/assessment?year=YYYY` | CRREM misalignment year and UK NZCBS indicative check |
| `GET /api/portfolio?year=YYYY` | Portfolio roll-up over the client's assets, with data-quality issues |
| `GET /api/exports/portfolio-energy?year=YYYY` | CSV, one row per asset |
| `GET /api/exports/portfolio-carbon?year=YYYY` | CSV, one row per asset |
| `GET /api/exports/asset-carbon?year=YYYY&asset={id}` | CSV, one row per carbon line |

Anything else gets 403 from the proxy, including every write, every page,
and organisation-wide data (readings, consents, transport, value chain,
SECR summary). For a key, `/api/portfolio` leaves out the organisation's
transport and site emissions. Another client's asset, or one assigned to
nobody, answers 404, so a key cannot find out which ids exist.

The allowlist is `clientMayRead` in `src/lib/api-keys/scope.ts`. A route
added to it must call `resolveAccess` and filter by `clientScope` or
`canSeeAsset`. `src/lib/api-keys/__tests__/routes.test.ts` checks that
every listed route rejects a bad key and hides other clients' assets, so
add any new route there too.

## Setting up a client

Run these wherever the portal runs, against the same `DB_PATH`:

```bash
pnpm api-keys add-client "Logicor"
pnpm api-keys assets                       # find the asset ids
pnpm api-keys assign Logicor <assetId> <assetId> ...
pnpm api-keys issue Logicor --label "Power BI refresh" --expires 2027-10-31
```

`issue` prints the key once. Only a SHA-256 hash is stored, so the key
cannot be shown again. If it is lost, issue a new key and revoke the old
one. Send it to the client by a secure channel, not in the same email as
the URL.

```bash
pnpm api-keys keys Logicor                 # label, last four characters, status, last used
pnpm api-keys revoke <keyId>
pnpm api-keys unassign <assetId>           # takes an asset out of the client's portfolio
```

Give each system its own key with a label naming it. That way one system
can be revoked without breaking the others, and `last used` shows which
keys are stale. Keys can be issued and revoked only from the command line,
never from the web UI.

## Presenting a key

Either form works:

```bash
curl -H "Authorization: Bearer nzc_..." "https://portal.example.com/api/exports/portfolio-carbon?year=2025"
curl -u "logicor:nzc_..." "https://portal.example.com/api/exports/portfolio-carbon?year=2025"
```

The Basic form takes any username, with the key as the password. It exists
because Power BI and Excel can store Basic credentials for scheduled
refresh. Keys are never accepted in the query string, where they would end
up in access logs.

### Power BI

1. **Get data → Web**, URL
   `https://<portal>/api/exports/portfolio-carbon?year=2025`.
2. When asked for credentials choose **Basic**. Enter any username and use
   the key as the password, at the level of the portal's root URL.
3. In the Power BI service, set the same Basic credentials on the
   dataset's data source to enable scheduled refresh. No gateway is
   needed for a publicly reachable portal.

Excel's **Data → From Web** works the same way.

## Operational notes

- **Use HTTPS.** Keys travel in a header, so serve the portal over HTTPS.
- **Independent of the portal password.** Keys work whether or not
  `PORTAL_BASIC_AUTH` is set. Without it, the rest of the portal stays
  open as before, so set it on any deployment a client can reach.
- **What keys don't do yet.** There is no rate limiting and no per-request
  audit log beyond `last_used_at`.
- **Format stability.** The CSV columns and JSON shapes are not yet
  versioned. Tell clients before changing a column they consume.
