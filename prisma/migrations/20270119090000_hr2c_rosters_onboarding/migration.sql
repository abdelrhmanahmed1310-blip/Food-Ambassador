-- HR2c: rosters, overtime and onboarding checklists (DECISIONS.md ADR-128).

-- CreateEnum
CREATE TYPE "OvertimeBase" AS ENUM ('BASIC', 'GROSS');

-- CreateEnum
CREATE TYPE "OvertimeDecisionStatus" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OnboardingAssignee" AS ENUM ('HR', 'MANAGER', 'EMPLOYEE');

-- CreateTable
CREATE TABLE "roster_settings" (
    "organization_id" UUID NOT NULL,
    "grace_minutes" INTEGER NOT NULL,
    "overtime_minimum_minutes" INTEGER NOT NULL,
    "standard_daily_hours" DECIMAL(5,2),
    "overtime_multiplier" DECIMAL(6,4),
    "overtime_base" "OvertimeBase",
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roster_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "shift_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" CHAR(5) NOT NULL,
    "end_time" CHAR(5) NOT NULL,
    "break_minutes" INTEGER NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_shifts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "start_time" CHAR(5) NOT NULL,
    "end_time" CHAR(5) NOT NULL,
    "break_minutes" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "template_id" UUID,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "published_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "roster_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_decisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "measured_minutes" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,
    "status" "OvertimeDecisionStatus" NOT NULL,
    "note" TEXT,
    "decided_by_user_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payroll_adjustment_id" UUID,

    CONSTRAINT "overtime_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_template_tasks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "due_days" INTEGER NOT NULL,
    "assignee" "OnboardingAssignee" NOT NULL,

    CONSTRAINT "onboarding_template_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_checklists" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "started_on" DATE NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,

    CONSTRAINT "onboarding_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_tasks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "checklist_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "due_on" DATE NOT NULL,
    "assignee" "OnboardingAssignee" NOT NULL,
    "done_at" TIMESTAMPTZ(3),
    "done_by_user_id" UUID,
    "note" TEXT,

    CONSTRAINT "onboarding_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shift_templates_organization_id_id_key" ON "shift_templates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shift_templates_organization_id_code_key" ON "shift_templates"("organization_id", "code");

-- CreateIndex
CREATE INDEX "roster_shifts_organization_id_branch_id_day_idx" ON "roster_shifts"("organization_id", "branch_id", "day");

-- CreateIndex
CREATE INDEX "roster_shifts_organization_id_employee_id_starts_at_idx" ON "roster_shifts"("organization_id", "employee_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "roster_shifts_organization_id_id_key" ON "roster_shifts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_decisions_shift_id_key" ON "overtime_decisions"("shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_decisions_payroll_adjustment_id_key" ON "overtime_decisions"("payroll_adjustment_id");

-- CreateIndex
CREATE INDEX "overtime_decisions_organization_id_status_employee_id_idx" ON "overtime_decisions"("organization_id", "status", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_decisions_organization_id_shift_id_key" ON "overtime_decisions"("organization_id", "shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_templates_organization_id_id_key" ON "onboarding_templates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_templates_organization_id_code_key" ON "onboarding_templates"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_template_tasks_organization_id_template_id_posit_key" ON "onboarding_template_tasks"("organization_id", "template_id", "position");

-- CreateIndex
CREATE INDEX "onboarding_checklists_organization_id_employee_id_idx" ON "onboarding_checklists"("organization_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_checklists_organization_id_id_key" ON "onboarding_checklists"("organization_id", "id");

-- CreateIndex
CREATE INDEX "onboarding_tasks_organization_id_due_on_idx" ON "onboarding_tasks"("organization_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_tasks_organization_id_checklist_id_position_key" ON "onboarding_tasks"("organization_id", "checklist_id", "position");

-- AddForeignKey
ALTER TABLE "roster_settings" ADD CONSTRAINT "roster_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "shift_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_decisions" ADD CONSTRAINT "overtime_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_decisions" ADD CONSTRAINT "overtime_decisions_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "roster_shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_decisions" ADD CONSTRAINT "overtime_decisions_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_decisions" ADD CONSTRAINT "overtime_decisions_payroll_adjustment_id_fkey" FOREIGN KEY ("payroll_adjustment_id") REFERENCES "payroll_adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_templates" ADD CONSTRAINT "onboarding_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_template_tasks" ADD CONSTRAINT "onboarding_template_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_template_tasks" ADD CONSTRAINT "onboarding_template_tasks_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "onboarding_templates"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "onboarding_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_organization_id_checklist_id_fkey" FOREIGN KEY ("organization_id", "checklist_id") REFERENCES "onboarding_checklists"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── HR2c rosters and onboarding (ADR-128): hand-written rules ───
ALTER TABLE "roster_settings" ADD CONSTRAINT "roster_settings_ck" CHECK (
  "grace_minutes" BETWEEN 0 AND 120 AND "overtime_minimum_minutes" BETWEEN 0 AND 240
  AND ("standard_daily_hours" IS NULL OR "standard_daily_hours" > 0 AND "standard_daily_hours" <= 24)
  AND ("overtime_multiplier" IS NULL OR "overtime_multiplier" >= 1 AND "overtime_multiplier" <= 10));
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_ck" CHECK (
  "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "break_minutes" BETWEEN 0 AND 240 AND length("name") BETWEEN 1 AND 80);
ALTER TABLE "roster_shifts" ADD CONSTRAINT "roster_shifts_ck" CHECK (
  "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "ends_at" > "starts_at" AND "ends_at" - "starts_at" <= interval '24 hours'
  AND "break_minutes" >= 0 AND make_interval(mins => "break_minutes") < "ends_at" - "starts_at"
  AND ("published_at" IS NULL) = ("published_by_user_id" IS NULL)
  AND ("cancelled_at" IS NULL OR ("published_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)));
ALTER TABLE "overtime_decisions" ADD CONSTRAINT "overtime_decisions_ck" CHECK (
  "measured_minutes" > 0 AND "minutes" BETWEEN 0 AND "measured_minutes"
  AND ("status" = 'APPROVED') = ("minutes" > 0)
  AND ("status" = 'APPROVED' OR "payroll_adjustment_id" IS NULL));
ALTER TABLE "onboarding_template_tasks" ADD CONSTRAINT "onboarding_template_tasks_ck" CHECK (
  length("title") BETWEEN 1 AND 200 AND "due_days" BETWEEN -30 AND 365 AND "position" BETWEEN 1 AND 100);
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_ck" CHECK (
  length("title") BETWEEN 1 AND 200 AND ("done_at" IS NULL) = ("done_by_user_id" IS NULL));
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_ck" CHECK (
  "completed_at" IS NULL OR "cancelled_at" IS NULL);
-- One open checklist of a template per employee.
CREATE UNIQUE INDEX "onboarding_checklists_open_key" ON "onboarding_checklists" ("organization_id", "employee_id", "template_id")
  WHERE "completed_at" IS NULL AND "cancelled_at" IS NULL;
-- A published shift keeps its times: it can only be cancelled. Only drafts are deleted.
CREATE OR REPLACE FUNCTION "roster_shifts_published"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."published_at" IS NOT NULL THEN
      RAISE EXCEPTION 'a published shift is cancelled, not deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."published_at" IS NOT NULL AND (NEW."employee_id", NEW."branch_id", NEW."day", NEW."start_time",
      NEW."end_time", NEW."break_minutes", NEW."starts_at", NEW."ends_at", NEW."published_at")
      IS DISTINCT FROM (OLD."employee_id", OLD."branch_id", OLD."day", OLD."start_time",
      OLD."end_time", OLD."break_minutes", OLD."starts_at", OLD."ends_at", OLD."published_at") THEN
    RAISE EXCEPTION 'a published shift cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."cancelled_at" IS NOT NULL AND NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at" THEN
    RAISE EXCEPTION 'a cancelled shift stays cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "roster_shifts_published" BEFORE UPDATE OR DELETE ON "roster_shifts"
  FOR EACH ROW EXECUTE FUNCTION "roster_shifts_published"();
-- A decision stands; only its payroll link moves.
CREATE OR REPLACE FUNCTION "overtime_decisions_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."shift_id", NEW."employee_id", NEW."measured_minutes", NEW."minutes", NEW."status", NEW."decided_by_user_id")
      IS DISTINCT FROM (OLD."shift_id", OLD."employee_id", OLD."measured_minutes", OLD."minutes", OLD."status", OLD."decided_by_user_id") THEN
    RAISE EXCEPTION 'an overtime decision cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "overtime_decisions_fixed" BEFORE UPDATE ON "overtime_decisions"
  FOR EACH ROW EXECUTE FUNCTION "overtime_decisions_fixed"();

GRANT SELECT, INSERT, UPDATE ON "roster_settings", "shift_templates", "overtime_decisions",
  "onboarding_templates", "onboarding_checklists", "onboarding_tasks" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "roster_shifts", "onboarding_template_tasks" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roster_settings', 'shift_templates', 'roster_shifts', 'overtime_decisions',
    'onboarding_templates', 'onboarding_template_tasks', 'onboarding_checklists', 'onboarding_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'rosters.manage'), ('operations_manager', 'rosters.manage'),
             ('branch_manager', 'rosters.manage'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
