-- HR4a: payroll (DECISIONS.md ADR-123). No statutory rate is preset (Q-20).

-- CreateEnum
CREATE TYPE "ProrationBasis" AS ENUM ('CALENDAR_DAYS', 'THIRTY_DAYS');

-- CreateEnum
CREATE TYPE "PayMethod" AS ENUM ('BANK', 'CASH');

-- CreateEnum
CREATE TYPE "ContributionAppliesTo" AS ENUM ('ALL', 'NATIONALS', 'NON_NATIONALS');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentKind" AS ENUM ('ADDITION', 'DEDUCTION');

-- CreateTable
CREATE TABLE "payroll_settings" (
    "organization_id" UUID NOT NULL,
    "proration_basis" "ProrationBasis" NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "employee_salaries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "basic" DECIMAL(19,4) NOT NULL,
    "pay_method" "PayMethod" NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_salaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salary_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "salary_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "in_contribution_base" BOOLEAN NOT NULL,

    CONSTRAINT "employee_salary_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bank_accounts" (
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "iban_sealed" TEXT NOT NULL,
    "iban_last4" TEXT NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_bank_accounts_pkey" PRIMARY KEY ("organization_id","employee_id")
);

-- CreateTable
CREATE TABLE "payroll_contribution_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "applies_to" "ContributionAppliesTo" NOT NULL,
    "employee_rate" DECIMAL(9,6) NOT NULL,
    "employer_rate" DECIMAL(9,6) NOT NULL,
    "base_min" DECIMAL(19,4),
    "base_max" DECIMAL(19,4),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_contribution_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "period" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "proration_basis" "ProrationBasis" NOT NULL,
    "gross" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "net" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "employer_contributions" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "employer_cost" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "prepared_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "paid_on" DATE,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "salary_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "pay_method" "PayMethod" NOT NULL,
    "basis_days" INTEGER NOT NULL,
    "paid_days" INTEGER NOT NULL,
    "unpaid_leave_days" DECIMAL(6,2) NOT NULL,
    "fixed_pay" DECIMAL(19,4) NOT NULL,
    "additions" DECIMAL(19,4) NOT NULL,
    "gross" DECIMAL(19,4) NOT NULL,
    "unpaid_leave_deduction" DECIMAL(19,4) NOT NULL,
    "employee_contributions" DECIMAL(19,4) NOT NULL,
    "other_deductions" DECIMAL(19,4) NOT NULL,
    "net" DECIMAL(19,4) NOT NULL,
    "employer_contributions" DECIMAL(19,4) NOT NULL,
    "employer_cost" DECIMAL(19,4) NOT NULL,
    "details" JSONB NOT NULL,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" "PayrollAdjustmentKind" NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_salaries_organization_id_id_key" ON "employee_salaries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_salaries_organization_id_employee_id_effective_fro_key" ON "employee_salaries"("organization_id", "employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "employee_salary_items_organization_id_salary_id_code_key" ON "employee_salary_items"("organization_id", "salary_id", "code");

-- CreateIndex
CREATE INDEX "payroll_contribution_rules_organization_id_company_id_effec_idx" ON "payroll_contribution_rules"("organization_id", "company_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_contribution_rules_organization_id_id_key" ON "payroll_contribution_rules"("organization_id", "id");

-- CreateIndex
CREATE INDEX "payroll_runs_organization_id_company_id_period_idx" ON "payroll_runs"("organization_id", "company_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_organization_id_id_key" ON "payroll_runs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_organization_id_number_key" ON "payroll_runs"("organization_id", "number");

-- CreateIndex
CREATE INDEX "payroll_lines_organization_id_employee_id_idx" ON "payroll_lines"("organization_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_organization_id_id_key" ON "payroll_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_organization_id_run_id_employee_id_key" ON "payroll_lines"("organization_id", "run_id", "employee_id");

-- CreateIndex
CREATE INDEX "payroll_adjustments_organization_id_run_id_employee_id_idx" ON "payroll_adjustments"("organization_id", "run_id", "employee_id");

-- AddForeignKey
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_items" ADD CONSTRAINT "employee_salary_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary_items" ADD CONSTRAINT "employee_salary_items_organization_id_salary_id_fkey" FOREIGN KEY ("organization_id", "salary_id") REFERENCES "employee_salaries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bank_accounts" ADD CONSTRAINT "employee_bank_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bank_accounts" ADD CONSTRAINT "employee_bank_accounts_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_contribution_rules" ADD CONSTRAINT "payroll_contribution_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_contribution_rules" ADD CONSTRAINT "payroll_contribution_rules_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "payroll_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "payroll_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── HR4a payroll (ADR-123): hand-written rules ───
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_ck" CHECK ("basic" >= 0);
ALTER TABLE "employee_salary_items" ADD CONSTRAINT "employee_salary_items_ck" CHECK (
  "amount" >= 0 AND "code" ~ '^[A-Z][A-Z0-9_]{0,19}$' AND "code" <> 'BASIC' AND length("name") BETWEEN 1 AND 60);
ALTER TABLE "payroll_contribution_rules" ADD CONSTRAINT "payroll_contribution_rules_ck" CHECK (
  "employee_rate" BETWEEN 0 AND 1 AND "employer_rate" BETWEEN 0 AND 1
  AND ("employee_rate" > 0 OR "employer_rate" > 0)
  AND ("base_min" IS NULL OR "base_min" >= 0)
  AND ("base_max" IS NULL OR "base_max" > 0)
  AND ("base_min" IS NULL OR "base_max" IS NULL OR "base_min" <= "base_max")
  AND ("effective_to" IS NULL OR "effective_to" >= "effective_from")
  AND "code" ~ '^[A-Z][A-Z0-9_]{0,19}$' AND length("source") BETWEEN 1 AND 300);
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_ck" CHECK (
  extract(day FROM "period") = 1
  AND ("approved_by_user_id" IS NULL OR "approved_by_user_id" <> "prepared_by_user_id")
  AND ("status" NOT IN ('APPROVED', 'PAID') OR "approved_at" IS NOT NULL)
  AND ("status" <> 'PAID' OR "paid_on" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL));
-- One live run per company and month.
CREATE UNIQUE INDEX "payroll_runs_one_live" ON "payroll_runs" ("organization_id", "company_id", "period")
  WHERE "status" <> 'CANCELLED';
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_ck" CHECK (
  "paid_days" BETWEEN 0 AND "basis_days" AND "basis_days" BETWEEN 28 AND 31);
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_ck" CHECK (
  "amount" > 0 AND (
    ("kind" = 'ADDITION' AND "category" IN ('OVERTIME', 'BONUS', 'COMMISSION', 'OTHER_ADDITION'))
    OR ("kind" = 'DEDUCTION' AND "category" IN ('ADVANCE_RECOVERY', 'INCOME_TAX', 'PENALTY', 'OTHER_DEDUCTION'))));

-- Pay history is never rewritten: a change is a new dated record.
CREATE OR REPLACE FUNCTION "payroll_fixed_record"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records cannot be changed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "employee_salaries_fixed" BEFORE UPDATE OR DELETE ON "employee_salaries"
  FOR EACH ROW EXECUTE FUNCTION "payroll_fixed_record"();
CREATE TRIGGER "employee_salary_items_fixed" BEFORE UPDATE OR DELETE ON "employee_salary_items"
  FOR EACH ROW EXECUTE FUNCTION "payroll_fixed_record"();

-- Lines and adjustments change only while their run is a draft.
CREATE OR REPLACE FUNCTION "payroll_run_is_draft"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "PayrollRunStatus";
BEGIN
  SELECT "status" INTO s FROM "payroll_runs"
    WHERE "id" = COALESCE(NEW."run_id", OLD."run_id");
  IF s IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'payroll run is no longer a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER "payroll_lines_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_lines"
  FOR EACH ROW EXECUTE FUNCTION "payroll_run_is_draft"();
CREATE TRIGGER "payroll_adjustments_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "payroll_run_is_draft"();

-- Runs move forward only, and their figures are fixed once approved.
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
    OR NEW."employer_cost" <> OLD."employer_cost" OR NEW."period" <> OLD."period"
    OR NEW."company_id" <> OLD."company_id") THEN
    RAISE EXCEPTION 'an approved payroll run cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "payroll_runs_transition" BEFORE UPDATE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION "payroll_runs_transition"();

GRANT SELECT, INSERT, UPDATE ON "payroll_settings", "employee_bank_accounts", "payroll_runs" TO fa_tenant;
GRANT SELECT, INSERT ON "employee_salaries", "employee_salary_items" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "payroll_contribution_rules" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_lines", "payroll_adjustments" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_settings', 'employee_salaries', 'employee_salary_items',
    'employee_bank_accounts', 'payroll_contribution_rules', 'payroll_runs', 'payroll_lines',
    'payroll_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'payroll.view'), ('admin', 'payroll.manage'), ('admin', 'payroll.approve'),
             ('finance', 'payroll.view'), ('finance', 'payroll.approve'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
