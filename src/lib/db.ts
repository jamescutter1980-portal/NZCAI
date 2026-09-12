import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __nzcaiPool: Pool | undefined;
}

/**
 * The pool is created on first use, not at module load. Next collects page
 * data at build time, when DATABASE_URL is typically absent - constructing
 * eagerly there fails the build, and on most hosts the connection string is
 * only injected at runtime anyway.
 */
export function getPool(): Pool {
  if (global.__nzcaiPool) return global.__nzcaiPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }

  const pool = new Pool({ connectionString, max: 10 });
  // The dev server reloads modules on every edit; caching on globalThis stops
  // a new pool per reload exhausting Postgres connections.
  global.__nzcaiPool = pool;
  return pool;
}

export async function query<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

export async function closePool(): Promise<void> {
  if (global.__nzcaiPool) {
    await global.__nzcaiPool.end();
    global.__nzcaiPool = undefined;
  }
}
