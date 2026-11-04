-- CreateTable
CREATE TABLE "sales_targets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "net_amount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_targets_organization_id_id_key" ON "sales_targets"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_targets_organization_id_branch_id_month_key" ON "sales_targets"("organization_id", "branch_id", "month");

-- AddForeignKey
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C4a sales targets (ADR-105): hand-written rules ───
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_ck" CHECK (
  "net_amount" >= 0 AND extract(day FROM "month") = 1 AND "currency" ~ '^[A-Z]{3}$');

GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_targets" TO fa_tenant;
ALTER TABLE "sales_targets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sales_targets" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

-- New permission for the system roles that set targets.
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'sales.targets.manage'), ('operations_manager', 'sales.targets.manage'),
             ('finance', 'sales.targets.manage'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
