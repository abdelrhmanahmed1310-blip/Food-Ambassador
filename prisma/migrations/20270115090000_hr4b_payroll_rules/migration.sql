-- HR4b: entered income tax and end-of-service rules (DECISIONS.md ADR-124). Nothing preset.

-- CreateEnum
CREATE TYPE "EosBase" AS ENUM ('BASIC', 'EOS_BASE');

-- AlterTable
ALTER TABLE "employee_salary_items" ADD COLUMN     "in_eos_base" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payroll_lines" ADD COLUMN     "eos_accrual" DECIMAL(19,4) NOT NULL DEFAULT 0,
ADD COLUMN     "eos_liability" DECIMAL(19,4) NOT NULL DEFAULT 0,
ADD COLUMN     "income_tax" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payroll_runs" ADD COLUMN     "eos_accrual" DECIMAL(19,4) NOT NULL DEFAULT 0,
ADD COLUMN     "income_tax" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payroll_tax_tables" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "applies_to" "ContributionAppliesTo" NOT NULL,
    "annual_exemption" DECIMAL(19,4) NOT NULL,
    "deduct_contributions" BOOLEAN NOT NULL,
    "bands" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_tax_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_eos_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "applies_to" "ContributionAppliesTo" NOT NULL,
    "base" "EosBase" NOT NULL,
    "tiers" JSONB NOT NULL,
    "resignation" JSONB NOT NULL,
    "cap_months" DECIMAL(9,4),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_eos_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_tax_tables_organization_id_company_id_effective_fro_idx" ON "payroll_tax_tables"("organization_id", "company_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_tax_tables_organization_id_id_key" ON "payroll_tax_tables"("organization_id", "id");

-- CreateIndex
CREATE INDEX "payroll_eos_rules_organization_id_company_id_effective_from_idx" ON "payroll_eos_rules"("organization_id", "company_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_eos_rules_organization_id_id_key" ON "payroll_eos_rules"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "payroll_tax_tables" ADD CONSTRAINT "payroll_tax_tables_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_tax_tables" ADD CONSTRAINT "payroll_tax_tables_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_eos_rules" ADD CONSTRAINT "payroll_eos_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_eos_rules" ADD CONSTRAINT "payroll_eos_rules_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── HR4b (ADR-124): hand-written rules ───
ALTER TABLE "payroll_tax_tables" ADD CONSTRAINT "payroll_tax_tables_ck" CHECK (
  "annual_exemption" >= 0 AND jsonb_typeof("bands") = 'array' AND jsonb_array_length("bands") BETWEEN 1 AND 12
  AND ("effective_to" IS NULL OR "effective_to" >= "effective_from")
  AND "code" ~ '^[A-Z][A-Z0-9_]{0,19}$' AND length("source") BETWEEN 1 AND 300);
ALTER TABLE "payroll_eos_rules" ADD CONSTRAINT "payroll_eos_rules_ck" CHECK (
  jsonb_typeof("tiers") = 'array' AND jsonb_array_length("tiers") BETWEEN 1 AND 6
  AND jsonb_typeof("resignation") = 'array'
  AND ("cap_months" IS NULL OR "cap_months" > 0)
  AND ("effective_to" IS NULL OR "effective_to" >= "effective_from")
  AND "code" ~ '^[A-Z][A-Z0-9_]{0,19}$' AND length("source") BETWEEN 1 AND 300);

-- End of service is paid as an addition.
ALTER TABLE "payroll_adjustments" DROP CONSTRAINT "payroll_adjustments_ck";
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_ck" CHECK (
  "amount" > 0 AND (
    ("kind" = 'ADDITION' AND "category" IN ('OVERTIME', 'BONUS', 'COMMISSION', 'OTHER_ADDITION', 'END_OF_SERVICE'))
    OR ("kind" = 'DEDUCTION' AND "category" IN ('ADVANCE_RECOVERY', 'INCOME_TAX', 'PENALTY', 'OTHER_DEDUCTION'))));
-- One end-of-service settlement per employee and run.
CREATE UNIQUE INDEX "payroll_adjustments_one_eos" ON "payroll_adjustments" ("organization_id", "run_id", "employee_id")
  WHERE "category" = 'END_OF_SERVICE';

-- Approved figures stay fixed, the new totals included.
CREATE OR REPLACE FUNCTION "payroll_runs_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> NEW."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('APPROVED', 'CANCELLED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PAID', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'payroll run cannot go from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
       NEW."gross" <> OLD."gross" OR NEW."deductions" <> OLD."deductions" OR NEW."net" <> OLD."net"
    OR NEW."employer_cost" <> OLD."employer_cost" OR NEW."income_tax" <> OLD."income_tax"
    OR NEW."eos_accrual" <> OLD."eos_accrual" OR NEW."period" <> OLD."period"
    OR NEW."company_id" <> OLD."company_id") THEN
    RAISE EXCEPTION 'an approved payroll run cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

GRANT SELECT, INSERT, UPDATE ON "payroll_tax_tables", "payroll_eos_rules" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_tax_tables', 'payroll_eos_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;
