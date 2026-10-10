import { NextResponse } from "next/server";
import type { Db } from "@/lib/db/sqlite";
import type { AssetRecord } from "@/lib/assets/types";
import { ApiKeysRepository, type KeyPrincipal } from "./repo";
import { presentedKey } from "./scope";

/**
 * Who is calling a client-readable route. Anything that reached the route
 * without a key has already passed the proxy's portal check, so it sees
 * everything; a key sees only its client's assets.
 */
export type Access = { kind: "portal" } | { kind: "client"; principal: KeyPrincipal };

export function resolveAccess(req: Request, db: Db): { ok: true; access: Access } | { ok: false; response: NextResponse } {
  const key = presentedKey(req.headers.get("authorization"), process.env.PORTAL_BASIC_AUTH?.trim());
  if (!key) return { ok: true, access: { kind: "portal" } };
  const principal = new ApiKeysRepository(db).verify(key);
  if (!principal) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "API key is not valid. It may have been revoked or have expired." },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="NZC Portal API"' } },
      ),
    };
  }
  return { ok: true, access: { kind: "client", principal } };
}

/** The asset filter for a caller: undefined means every asset. */
export function clientScope(access: Access): { clientId?: string } {
  return access.kind === "client" ? { clientId: access.principal.clientId } : {};
}

/**
 * Whether the caller may see an asset. Routes answer 404 rather than 403 when
 * this is false, so a key cannot probe for other clients' asset ids.
 */
export function canSeeAsset(access: Access, asset: AssetRecord): boolean {
  return access.kind === "portal" || asset.clientId === access.principal.clientId;
}

/** An asset as the caller may see it: internal notes stay inside the portal. */
export function assetView(access: Access, asset: AssetRecord): AssetRecord {
  if (access.kind === "portal") return asset;
  return { ...asset, notes: undefined };
}
