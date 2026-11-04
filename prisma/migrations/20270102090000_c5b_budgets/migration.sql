-- CreateEnum
CREATE TYPE "BudgetLine" AS ENUM ('COST_OF_SALES', 'OCCUPANCY', 'UTILITIES', 'STAFF', 'MARKETING', 'REPAIRS', 'ADMINISTRATION', 'DELIVERY', 'OTHER');

-- CreateTable
CREATE TABLE "branch_budgets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "line" "BudgetLine" NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branch_budgets_organization_id_id_key" ON "branch_budgets"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_budgets_organization_id_branch_id_month_line_key" ON "branch_budgets"("organization_id", "branch_id", "month", "line");

-- AddForeignKey
ALTER TABLE "branch_budgets" ADD CONSTRAINT "branch_budgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_budgets" ADD CONSTRAINT "branch_budgets_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C5b budgets (ADR-110): hand-written rules ───
ALTER TABLE "branch_budgets" ADD CONSTRAINT "branch_budgets_ck" CHECK (
  "amount" >= 0 AND extract(day FROM "month") = 1 AND "currency" ~ '^[A-Z]{3}$');

GRANT SELECT, INSERT, UPDATE, DELETE ON "branch_budgets" TO fa_tenant;
ALTER TABLE "branch_budgets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "branch_budgets" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'budgets.view'), ('admin', 'budgets.manage'),
             ('finance', 'budgets.view'), ('finance', 'budgets.manage'),
             ('operations_manager', 'budgets.view'), ('branch_manager', 'budgets.view'),
             ('analyst', 'budgets.view'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
