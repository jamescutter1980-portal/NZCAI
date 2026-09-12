import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { closePool, getPool } from "@/lib/db";

async function main(): Promise<void> {
  const dir = join(process.cwd(), "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    process.stdout.write(`applying ${file} ... `);
    const sql = readFileSync(join(dir, file), "utf8");
    await getPool().query(sql);
    process.stdout.write("ok\n");
  }

  const { DNOS } = await import("./registry");
  for (const dno of DNOS) {
    await getPool().query(
      `INSERT INTO dno (id, name, portal_host) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
                                      portal_host = EXCLUDED.portal_host`,
      [dno.id, dno.name, dno.portalHost],
    );
  }
  console.log(`seeded ${DNOS.length} DNO rows`);
  await closePool();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
