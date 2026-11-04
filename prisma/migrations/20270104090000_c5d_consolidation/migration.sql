-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "group_company_id" UUID;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_group_company_id_fkey" FOREIGN KEY ("organization_id", "group_company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C5d consolidation (ADR-112): hand-written rules ───
CREATE INDEX "customers_group_company_idx" ON "customers"("organization_id", "group_company_id")
  WHERE "group_company_id" IS NOT NULL;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'pnl.consolidated.view'), ('finance', 'pnl.consolidated.view'),
             ('operations_manager', 'pnl.consolidated.view'), ('analyst', 'pnl.consolidated.view'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
