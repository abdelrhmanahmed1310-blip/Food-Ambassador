import "dotenv/config";
import { execFileSync } from "node:child_process";
import { Client } from "pg";

/** The database name in a connection URL. */
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/**
 * Whether the test database may be wiped: only a database whose name ends in
 * `_test`, and never the same database as DATABASE_URL (outside CI, where the
 * database is a disposable service container).
 */
export function mayResetTestDatabase(env: NodeJS.ProcessEnv): { ok: boolean; why?: string } {
  const url = env.TEST_DATABASE_URL;
  if (!url) return { ok: false, why: "TEST_DATABASE_URL is not set" };
  if (!databaseName(url).endsWith("_test"))
    return { ok: false, why: `the test database name must end in _test (${databaseName(url)})` };
  if (env.DATABASE_URL && databaseName(env.DATABASE_URL) === databaseName(url) && env.CI !== "true")
    return { ok: false, why: "TEST_DATABASE_URL points at the same database as DATABASE_URL" };
  return { ok: true };
}

/**
 * Integration test set-up. Each run starts from an empty test database built
 * from the migrations, so the shared database does not grow from run to run
 * and slow the suite down (decided 2026-11-26). Set TEST_DB_KEEP=1 to keep the
 * existing data and only apply pending migrations. Tests still never assume an
 * empty database: every test creates its own uniquely named data.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL must be set to run integration tests");
  if (process.env.TEST_DB_KEEP !== "1") {
    const allowed = mayResetTestDatabase(process.env);
    if (!allowed.ok) {
      const message = `Refusing to reset the test database: ${allowed.why}`;
      // Printed as well: Vitest can hide errors thrown from global set-up.
      console.error(message);
      throw new Error(message);
    }
    const client = new Client({ connectionString: url.replace(/\?.*$/, "") });
    await client.connect();
    try {
      // The migrations recreate everything in the schema, including the
      // pg_trgm extension and the fa_tenant role's grants.
      await client.query("DROP SCHEMA IF EXISTS public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query("GRANT USAGE ON SCHEMA public TO PUBLIC");
    } finally {
      await client.end();
    }
  }
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
}
