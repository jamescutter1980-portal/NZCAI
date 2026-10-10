/**
 * What a client API key may reach, and how one is presented. No database or
 * crypto here: the proxy imports this to turn keys away from everything else
 * before a route runs, and the routes verify the key itself.
 */

export const KEY_PREFIX = "nzc_";

/** True for anything shaped like one of our keys; says nothing about validity. */
export const looksLikeKey = (value: string) => value.startsWith(KEY_PREFIX) && value.length > KEY_PREFIX.length + 16;

/**
 * Read-only routes a key can call. Each one filters to the key's client, so
 * adding a path here without scoping its handler would leak other clients'
 * assets; the api-keys route test walks this list to catch that. Company-wide
 * data (readings, consents, transport, value chain, SECR) is deliberately absent.
 */
const CLIENT_READABLE: RegExp[] = [
  /^\/api\/assets$/,
  /^\/api\/assets\/[^/]+$/,
  /^\/api\/assets\/[^/]+\/(?:carbon|assessment)$/,
  /^\/api\/portfolio$/,
  /^\/api\/exports\/(?:portfolio-energy|portfolio-carbon|asset-carbon)$/,
];

export function clientMayRead(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return CLIENT_READABLE.some((re) => re.test(pathname));
}

/**
 * The API key in an Authorization header, if there is one. Accepted as
 * `Bearer <key>` or as the password of Basic auth with any username, because
 * Power BI and Excel can store Basic credentials for scheduled refresh but
 * not a custom header. The portal's own password is never treated as a key.
 */
export function presentedKey(header: string | null, portalCredentials?: string): string | undefined {
  if (!header) return undefined;
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) {
    const key = bearer[1].trim();
    return looksLikeKey(key) ? key : undefined;
  }
  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (!basic) return undefined;
  const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
  if (portalCredentials && decoded === portalCredentials) return undefined;
  const colon = decoded.indexOf(":");
  const password = colon >= 0 ? decoded.slice(colon + 1) : "";
  return looksLikeKey(password) ? password : undefined;
}
