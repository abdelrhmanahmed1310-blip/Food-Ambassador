/**
 * Database integrity check for operations (docs/OPERATIONS.md): run after a
 * restore, a migration or on a schedule. Exits 1 when anything is wrong.
 *
 *   pnpm db:verify            # DATABASE_URL from the environment or .env
 *
 * Checks: every tenant table has row-level security and its policy; stock
 * balances equal the ledger; stock values equal ledger + revaluations +
 * landed costs; no negative or over-reserved stock; all migrations applied.
 * Prints counts only — never data.
 */
import "dotenv/config";
import { readdirSync } from "node:fs";
import { getDb } from "@/server/db/client";

type Row = Record<string, unknown>;

async function main() {
  const db = getDb();
  const problems: string[] = [];
  const check = async (name: string, sql: string) => {
    const rows = (await db.$queryRawUnsafe(sql)) as Row[];
    if (rows.length > 0) problems.push(`${name}: ${rows.length} (e.g. ${JSON.stringify(rows[0])})`);
    console.log(`${rows.length === 0 ? "ok  " : "FAIL"} ${name}`);
  };

  await check(
    "tenant tables without row-level security or policy",
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN information_schema.columns col ON col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'organization_id'
      WHERE c.relkind = 'r' AND c.relname <> 'organizations'
        AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))`,
  );
  await check(
    "stock balances that differ from the ledger",
    `WITH ledger AS (
       SELECT organization_id, warehouse_id, location_id, product_id, lot_id, stock_status, SUM(quantity_delta) AS qty
       FROM inventory_ledger_entries GROUP BY 1, 2, 3, 4, 5, 6)
     SELECT COALESCE(l.organization_id, b.organization_id) AS org, COALESCE(l.qty, 0)::text AS ledger, COALESCE(b.on_hand_quantity, 0)::text AS balance
     FROM ledger l FULL OUTER JOIN stock_balances b
       ON b.organization_id = l.organization_id AND b.warehouse_id = l.warehouse_id
      AND b.location_id IS NOT DISTINCT FROM l.location_id AND b.product_id = l.product_id
      AND b.lot_id IS NOT DISTINCT FROM l.lot_id AND b.stock_status = l.stock_status
     WHERE COALESCE(l.qty, 0) <> COALESCE(b.on_hand_quantity, 0)`,
  );
  await check(
    "stock values that differ from ledger, revaluations and landed costs",
    `WITH balances AS (
       SELECT organization_id, warehouse_id, product_id, SUM(on_hand_quantity) AS qty FROM stock_balances GROUP BY 1, 2, 3),
     ledger AS (
       SELECT organization_id, warehouse_id, product_id, SUM(value_delta) AS value FROM inventory_ledger_entries GROUP BY 1, 2, 3),
     extra AS (
       SELECT organization_id, warehouse_id, product_id, SUM(v) AS value FROM (
         SELECT organization_id, warehouse_id, product_id, value_delta AS v FROM stock_revaluations
         UNION ALL SELECT organization_id, warehouse_id, product_id, capitalized_amount FROM landed_cost_lines) x
       GROUP BY 1, 2, 3),
     expected AS (
       SELECT COALESCE(b.organization_id, l.organization_id) AS organization_id,
              COALESCE(b.warehouse_id, l.warehouse_id) AS warehouse_id, COALESCE(b.product_id, l.product_id) AS product_id,
              COALESCE(b.qty, 0) AS qty, COALESCE(l.value, 0) + COALESCE(e.value, 0) AS value
       FROM balances b
       FULL OUTER JOIN ledger l ON l.organization_id = b.organization_id AND l.warehouse_id = b.warehouse_id AND l.product_id = b.product_id
       LEFT JOIN extra e ON e.organization_id = COALESCE(b.organization_id, l.organization_id)
        AND e.warehouse_id = COALESCE(b.warehouse_id, l.warehouse_id) AND e.product_id = COALESCE(b.product_id, l.product_id))
     SELECT COALESCE(v.organization_id, x.organization_id) AS org, COALESCE(v.total_value, 0)::text AS stored, COALESCE(x.value, 0)::text AS expected
     FROM stock_valuations v
     FULL OUTER JOIN expected x ON x.organization_id = v.organization_id AND x.warehouse_id = v.warehouse_id AND x.product_id = v.product_id
     WHERE COALESCE(v.quantity, 0) <> COALESCE(x.qty, 0) OR COALESCE(v.total_value, 0) <> COALESCE(x.value, 0)`,
  );
  await check(
    "negative or over-reserved stock",
    `SELECT organization_id AS org FROM stock_balances WHERE on_hand_quantity < 0 OR reserved_quantity < 0 OR reserved_quantity > on_hand_quantity`,
  );
  const applied = (await db.$queryRawUnsafe(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  )) as Array<{ migration_name: string }>;
  const folders = readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const missing = folders.filter((f) => !applied.some((a) => a.migration_name === f));
  console.log(
    `${missing.length === 0 ? "ok  " : "FAIL"} migrations applied (${applied.length}/${folders.length})`,
  );
  if (missing.length > 0) problems.push(`migrations not applied: ${missing.join(", ")}`);

  const counts = (await db.$queryRawUnsafe(
    `SELECT (SELECT count(*) FROM organizations)::int AS organizations, (SELECT count(*) FROM users)::int AS users,
            (SELECT count(*) FROM inventory_ledger_entries)::int AS ledger_entries, (SELECT count(*) FROM audit_events)::int AS audit_events`,
  )) as Row[];
  console.log("counts", JSON.stringify(counts[0]));
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
  } else console.log("\nAll checks passed.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => getDb().$disconnect());
