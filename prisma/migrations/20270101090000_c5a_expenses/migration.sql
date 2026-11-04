-- CreateEnum
CREATE TYPE "ExpenseGroup" AS ENUM ('OCCUPANCY', 'UTILITIES', 'STAFF', 'MARKETING', 'REPAIRS', 'ADMINISTRATION', 'DELIVERY', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('POSTED', 'REVERSED');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'EXPENSE';

-- CreateTable
CREATE TABLE "cost_centres" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branch_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_centres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "group" "ExpenseGroup" NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "cost_centre_id" UUID,
    "category_id" UUID NOT NULL,
    "supplier_id" UUID,
    "expense_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "net_amount" DECIMAL(19,4) NOT NULL,
    "tax_amount" DECIMAL(19,4) NOT NULL,
    "gross_amount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'POSTED',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_user_id" UUID,
    "reverse_reason" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cost_centres_organization_id_id_key" ON "cost_centres"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centres_organization_id_code_key" ON "cost_centres"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_organization_id_id_key" ON "expense_categories"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_organization_id_code_key" ON "expense_categories"("organization_id", "code");

-- CreateIndex
CREATE INDEX "expenses_organization_id_branch_id_expense_date_idx" ON "expenses"("organization_id", "branch_id", "expense_date");

-- CreateIndex
CREATE INDEX "expenses_organization_id_category_id_expense_date_idx" ON "expenses"("organization_id", "category_id", "expense_date");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_organization_id_id_key" ON "expenses"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_organization_id_number_key" ON "expenses"("organization_id", "number");

-- AddForeignKey
ALTER TABLE "cost_centres" ADD CONSTRAINT "cost_centres_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centres" ADD CONSTRAINT "cost_centres_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_cost_centre_id_fkey" FOREIGN KEY ("organization_id", "cost_centre_id") REFERENCES "cost_centres"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "expense_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C5a operating expenses (ADR-109): hand-written rules ───
ALTER TABLE "cost_centres" ADD CONSTRAINT "cost_centres_ck" CHECK (
  length(btrim("code")) > 0 AND length(btrim("name")) > 0);
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_ck" CHECK (
  length(btrim("code")) > 0 AND length(btrim("name")) > 0);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_ck" CHECK (
  length(btrim("description")) > 0
  AND "net_amount" > 0 AND "tax_amount" >= 0
  AND "gross_amount" = "net_amount" + "tax_amount"
  AND "currency" ~ '^[A-Z]{3}$'
  AND ("status" = 'POSTED') = ("reversed_at" IS NULL)
  AND ("reversed_at" IS NULL OR ("reversed_by_user_id" IS NOT NULL
       AND length(btrim(coalesce("reverse_reason", ''))) > 0)));

-- An expense is a record: only its reversal may be added, once.
CREATE OR REPLACE FUNCTION expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'POSTED' THEN
    RAISE EXCEPTION 'expense % is reversed and cannot change', OLD."number";
  END IF;
  IF NEW."number" <> OLD."number" OR NEW."branch_id" <> OLD."branch_id"
     OR NEW."cost_centre_id" IS DISTINCT FROM OLD."cost_centre_id"
     OR NEW."category_id" <> OLD."category_id"
     OR NEW."supplier_id" IS DISTINCT FROM OLD."supplier_id"
     OR NEW."expense_date" <> OLD."expense_date" OR NEW."description" <> OLD."description"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."net_amount" <> OLD."net_amount" OR NEW."tax_amount" <> OLD."tax_amount"
     OR NEW."gross_amount" <> OLD."gross_amount" OR NEW."currency" <> OLD."currency" THEN
    RAISE EXCEPTION 'a posted expense cannot be edited; reverse it instead';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "expenses_guard" BEFORE UPDATE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION expense_guard();

GRANT SELECT, INSERT, UPDATE ON "cost_centres", "expense_categories", "expenses" TO fa_tenant;
ALTER TABLE "cost_centres" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "cost_centres" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "expense_categories" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "expenses" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'expenses.view'), ('admin', 'expenses.manage'),
             ('finance', 'expenses.view'), ('finance', 'expenses.manage'),
             ('operations_manager', 'expenses.view'),
             ('branch_manager', 'expenses.view'), ('branch_manager', 'expenses.manage'),
             ('analyst', 'expenses.view'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
