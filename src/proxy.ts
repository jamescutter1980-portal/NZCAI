import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional HTTP Basic Auth for the whole portal. Set PORTAL_BASIC_AUTH to
 * "user:password" to enable. Sync requests carrying a valid SYNC_TOKEN pass
 * through so schedulers do not need the password. Replace with real user
 * accounts before multi-user use.
 */
export function proxy(req: NextRequest) {
  const expected = process.env.PORTAL_BASIC_AUTH?.trim();
  if (!expected) return NextResponse.next();

  const syncToken = process.env.SYNC_TOKEN?.trim();
  if (syncToken && req.nextUrl.pathname === "/api/n3rgy/sync") {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (bearer === syncToken || req.nextUrl.searchParams.get("token") === syncToken) return NextResponse.next();
  }

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    if (timingSafeEqual(decoded, expected)) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="NZC Portal", charset="UTF-8"' },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
