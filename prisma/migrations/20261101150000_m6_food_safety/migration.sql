-- CreateEnum
CREATE TYPE "CheckpointKind" AS ENUM ('FRIDGE', 'FREEZER', 'HOT_HOLDING', 'COOKING', 'AMBIENT', 'OTHER');

-- CreateEnum
CREATE TYPE "SafetyRecordType" AS ENUM ('TEMPERATURE', 'HYGIENE', 'CLEANING', 'PEST_CONTROL', 'OTHER');

-- CreateEnum
CREATE TYPE "ChecklistItemKind" AS ENUM ('YES_NO', 'NUMBER');

-- CreateEnum
CREATE TYPE "NcSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NcSource" AS ENUM ('MANUAL', 'RECORD', 'CHECKLIST');

-- CreateEnum
CREATE TYPE "NcStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'ACTION_PLANNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CorrectiveActionStatus" AS ENUM ('OPEN', 'DONE', 'VERIFIED');

-- CreateTable
CREATE TABLE "safety_checkpoints" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CheckpointKind" NOT NULL,
    "min_celsius" DECIMAL(5,1),
    "max_celsius" DECIMAL(5,1),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "safety_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_safety_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "checkpoint_id" UUID,
    "type" "SafetyRecordType" NOT NULL,
    "value_celsius" DECIMAL(5,1),
    "min_celsius" DECIMAL(5,1),
    "max_celsius" DECIMAL(5,1),
    "passed" BOOLEAN,
    "in_spec" BOOLEAN NOT NULL,
    "note" TEXT,
    "corrective_note" TEXT,
    "non_conformance_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_user_id" UUID NOT NULL,

    CONSTRAINT "food_safety_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "kind" "ChecklistItemKind" NOT NULL,
    "min_value" DECIMAL(12,3),
    "max_value" DECIMAL(12,3),
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "failed_count" INTEGER NOT NULL,
    "note" TEXT,
    "non_conformance_id" UUID,
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_by_user_id" UUID NOT NULL,

    CONSTRAINT "checklist_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_answers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "kind" "ChecklistItemKind" NOT NULL,
    "min_value" DECIMAL(12,3),
    "max_value" DECIMAL(12,3),
    "yes" BOOLEAN,
    "value" DECIMAL(12,3),
    "ok" BOOLEAN NOT NULL,
    "note" TEXT,

    CONSTRAINT "checklist_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "non_conformances" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "NcSeverity" NOT NULL,
    "source" "NcSource" NOT NULL,
    "status" "NcStatus" NOT NULL DEFAULT 'OPEN',
    "root_cause" TEXT,
    "raised_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raised_by_user_id" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_user_id" UUID,
    "close_note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "non_conformances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corrective_actions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "non_conformance_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "owner_user_id" UUID,
    "due_on" DATE,
    "status" "CorrectiveActionStatus" NOT NULL DEFAULT 'OPEN',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at" TIMESTAMPTZ(3),
    "done_by_user_id" UUID,
    "done_note" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_user_id" UUID,
    "verify_note" TEXT,

    CONSTRAINT "corrective_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "safety_checkpoints_organization_id_id_key" ON "safety_checkpoints"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "safety_checkpoints_organization_id_branch_id_code_key" ON "safety_checkpoints"("organization_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "food_safety_records_organization_id_branch_id_recorded_at_idx" ON "food_safety_records"("organization_id", "branch_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "food_safety_records_organization_id_checkpoint_id_recorded__idx" ON "food_safety_records"("organization_id", "checkpoint_id", "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_safety_records_organization_id_id_key" ON "food_safety_records"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_templates_organization_id_id_key" ON "checklist_templates"("organization_id", "id");

-- CreateIndex
CREATE INDEX "checklist_items_organization_id_template_id_position_idx" ON "checklist_items"("organization_id", "template_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_items_organization_id_id_key" ON "checklist_items"("organization_id", "id");

-- CreateIndex
CREATE INDEX "checklist_runs_organization_id_branch_id_completed_at_idx" ON "checklist_runs"("organization_id", "branch_id", "completed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "checklist_runs_organization_id_id_key" ON "checklist_runs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_answers_organization_id_id_key" ON "checklist_answers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_answers_organization_id_run_id_item_id_key" ON "checklist_answers"("organization_id", "run_id", "item_id");

-- CreateIndex
CREATE INDEX "non_conformances_organization_id_status_idx" ON "non_conformances"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "non_conformances_organization_id_id_key" ON "non_conformances"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "non_conformances_organization_id_number_key" ON "non_conformances"("organization_id", "number");

-- CreateIndex
CREATE INDEX "corrective_actions_organization_id_non_conformance_id_idx" ON "corrective_actions"("organization_id", "non_conformance_id");

-- CreateIndex
CREATE UNIQUE INDEX "corrective_actions_organization_id_id_key" ON "corrective_actions"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "safety_checkpoints" ADD CONSTRAINT "safety_checkpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_checkpoints" ADD CONSTRAINT "safety_checkpoints_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_safety_records" ADD CONSTRAINT "food_safety_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_safety_records" ADD CONSTRAINT "food_safety_records_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_safety_records" ADD CONSTRAINT "food_safety_records_organization_id_checkpoint_id_fkey" FOREIGN KEY ("organization_id", "checkpoint_id") REFERENCES "safety_checkpoints"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_safety_records" ADD CONSTRAINT "food_safety_records_organization_id_non_conformance_id_fkey" FOREIGN KEY ("organization_id", "non_conformance_id") REFERENCES "non_conformances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "checklist_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "checklist_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_organization_id_non_conformance_id_fkey" FOREIGN KEY ("organization_id", "non_conformance_id") REFERENCES "non_conformances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "checklist_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_organization_id_non_conformance_id_fkey" FOREIGN KEY ("organization_id", "non_conformance_id") REFERENCES "non_conformances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-035) ───

ALTER TABLE "safety_checkpoints" ADD CONSTRAINT "safety_checkpoints_limits_ck"
  CHECK ("min_celsius" IS NULL OR "max_celsius" IS NULL OR "min_celsius" <= "max_celsius");
ALTER TABLE "food_safety_records" ADD CONSTRAINT "food_safety_records_values_ck"
  CHECK ((("type" = 'TEMPERATURE') = ("value_celsius" IS NOT NULL))
         AND (("type" = 'TEMPERATURE') = ("passed" IS NULL))
         AND ("in_spec" OR "corrective_note" IS NOT NULL));
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_limits_ck"
  CHECK ("position" > 0 AND ("kind" = 'NUMBER' OR ("min_value" IS NULL AND "max_value" IS NULL))
         AND ("min_value" IS NULL OR "max_value" IS NULL OR "min_value" <= "max_value"));
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_value_ck"
  CHECK (("kind" = 'YES_NO' AND "yes" IS NOT NULL AND "value" IS NULL)
      OR ("kind" = 'NUMBER' AND "value" IS NOT NULL AND "yes" IS NULL));
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_failed_ck" CHECK ("failed_count" >= 0);
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_status_ck"
  CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_status_ck"
  CHECK (("status" = 'OPEN' AND "done_at" IS NULL AND "verified_at" IS NULL)
      OR ("status" = 'DONE' AND "done_at" IS NOT NULL AND "verified_at" IS NULL)
      OR ("status" = 'VERIFIED' AND "done_at" IS NOT NULL AND "verified_at" IS NOT NULL
          AND "verified_by_user_id" IS DISTINCT FROM "done_by_user_id"));

-- Records and completed checklists are evidence: append-only (the link to a
-- non-conformance is set in the same transaction as the insert).
CREATE TRIGGER "food_safety_records_append_only" BEFORE DELETE ON "food_safety_records"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "checklist_answers_append_only" BEFORE UPDATE OR DELETE ON "checklist_answers"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "checklist_runs_no_delete" BEFORE DELETE ON "checklist_runs"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "safety_checkpoints", "checklist_templates", "checklist_items",
  "non_conformances", "corrective_actions" TO fa_tenant;
GRANT SELECT, INSERT ON "checklist_answers" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ("non_conformance_id") ON "food_safety_records", "checklist_runs" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['safety_checkpoints', 'food_safety_records', 'checklist_templates',
                           'checklist_items', 'checklist_runs', 'checklist_answers',
                           'non_conformances', 'corrective_actions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- ─── New permissions for existing organizations' system roles ───
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'foodsafety.view'), ('admin', 'foodsafety.record'), ('admin', 'foodsafety.manage'),
  ('operations_manager', 'foodsafety.view'), ('operations_manager', 'foodsafety.record'),
  ('operations_manager', 'foodsafety.manage'),
  ('food_safety', 'foodsafety.view'), ('food_safety', 'foodsafety.record'), ('food_safety', 'foodsafety.manage'),
  ('branch_manager', 'foodsafety.view'), ('branch_manager', 'foodsafety.record'),
  ('branch_manager', 'foodsafety.manage'),
  ('warehouse', 'foodsafety.view'), ('warehouse', 'foodsafety.record'),
  ('analyst', 'foodsafety.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
