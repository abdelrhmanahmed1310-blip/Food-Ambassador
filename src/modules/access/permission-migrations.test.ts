import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, SYSTEM_ROLE_TEMPLATES } from "./permissions";

/**
 * Existing organizations receive new permissions through SQL data migrations,
 * while new organizations get them from SYSTEM_ROLE_TEMPLATES. This test keeps
 * the two in sync: for every permission granted by a migration, the template
 * must grant it too, and every non-owner/admin template permission introduced
 * after M1 must be granted by some migration.
 */
const M1_PERMISSIONS = new Set([
  "org.settings.manage",
  "members.view",
  "members.manage",
  "roles.manage",
  "branches.view",
  "branches.manage",
  "warehouses.view",
  "warehouses.manage",
  "audit.view",
]);

function migrationGrants(): Set<string> {
  const dir = join(process.cwd(), "prisma", "migrations");
  const grants = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!/^\d+_/.test(name)) continue;
    const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
    if (!sql.includes('INSERT INTO "role_permissions"')) continue;
    for (const m of sql.matchAll(/\('([a-z_]+)', '([a-z0-9.]+)'\)/g)) grants.add(`${m[1]}:${m[2]}`);
  }
  return grants;
}

describe("permission data migrations", () => {
  const grants = migrationGrants();

  it("only grant catalogued permissions that the template also grants", () => {
    for (const g of grants) {
      const [role, permission] = g.split(":");
      expect(PERMISSIONS as readonly string[], g).toContain(permission);
      const template = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === role);
      expect(template?.permissions, g).toContain(permission);
    }
  });

  it("grant every post-M1 template permission to existing organizations", () => {
    for (const t of SYSTEM_ROLE_TEMPLATES) {
      if (t.key === "owner") continue; // owner always holds everything, computed in code
      for (const p of t.permissions) {
        if (M1_PERMISSIONS.has(p)) continue;
        expect(grants.has(`${t.key}:${p}`), `${t.key}:${p}`).toBe(true);
      }
    }
  });
});
