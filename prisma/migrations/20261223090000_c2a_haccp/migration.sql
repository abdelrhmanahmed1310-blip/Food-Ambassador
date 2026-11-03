-- CreateEnum
CREATE TYPE "HaccpPlanStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "HazardType" AS ENUM ('BIOLOGICAL', 'CHEMICAL', 'PHYSICAL', 'ALLERGEN');

-- CreateEnum
CREATE TYPE "ControlClass" AS ENUM ('CCP', 'OPRP', 'PRP');

-- DropForeignKey
ALTER TABLE "supplier_return_lines" DROP CONSTRAINT "supplier_return_lines_lot_fkey";

-- AlterTable
ALTER TABLE "non_conformances" ADD COLUMN     "control_point_id" UUID;

-- CreateTable
CREATE TABLE "haccp_plans" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "branch_id" UUID,
    "scope" TEXT NOT NULL,
    "intended_use" TEXT,
    "team" TEXT,
    "status" "HaccpPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(3),
    "approved_by_user_id" UUID,
    "review_due_on" DATE,
    "superseded_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "haccp_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "haccp_steps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "haccp_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "haccp_hazards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "type" "HazardType" NOT NULL,
    "description" TEXT NOT NULL,
    "likelihood" INTEGER NOT NULL,
    "severity" INTEGER NOT NULL,
    "significant" BOOLEAN NOT NULL,
    "control_measures" TEXT,
    "q1" BOOLEAN,
    "q2" BOOLEAN,
    "q3" BOOLEAN,
    "q4" BOOLEAN,
    "tree_result" "ControlClass",
    "classification" "ControlClass" NOT NULL,
    "justification" TEXT,

    CONSTRAINT "haccp_hazards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "haccp_control_points" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "hazard_id" UUID NOT NULL,
    "critical_limit" TEXT NOT NULL,
    "min_value" DECIMAL(12,3),
    "max_value" DECIMAL(12,3),
    "unit" TEXT,
    "monitoring" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "responsible" TEXT,
    "corrective_action" TEXT NOT NULL,
    "verification" TEXT NOT NULL,
    "records_kept" TEXT,

    CONSTRAINT "haccp_control_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "haccp_control_point_checkpoints" (
    "organization_id" UUID NOT NULL,
    "control_point_id" UUID NOT NULL,
    "checkpoint_id" UUID NOT NULL,

    CONSTRAINT "haccp_control_point_checkpoints_pkey" PRIMARY KEY ("organization_id","control_point_id","checkpoint_id")
);

-- CreateIndex
CREATE INDEX "haccp_plans_organization_id_status_idx" ON "haccp_plans"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "haccp_plans_organization_id_id_key" ON "haccp_plans"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "haccp_plans_organization_id_code_version_key" ON "haccp_plans"("organization_id", "code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "haccp_steps_organization_id_id_key" ON "haccp_steps"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "haccp_steps_organization_id_plan_id_position_key" ON "haccp_steps"("organization_id", "plan_id", "position");

-- CreateIndex
CREATE INDEX "haccp_hazards_organization_id_plan_id_idx" ON "haccp_hazards"("organization_id", "plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "haccp_hazards_organization_id_id_key" ON "haccp_hazards"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "haccp_control_points_organization_id_id_key" ON "haccp_control_points"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "haccp_control_points_organization_id_hazard_id_key" ON "haccp_control_points"("organization_id", "hazard_id");

-- CreateIndex
CREATE INDEX "haccp_control_point_checkpoints_organization_id_checkpoint__idx" ON "haccp_control_point_checkpoints"("organization_id", "checkpoint_id");

-- AddForeignKey
ALTER TABLE "non_conformances" ADD CONSTRAINT "non_conformances_organization_id_control_point_id_fkey" FOREIGN KEY ("organization_id", "control_point_id") REFERENCES "haccp_control_points"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_plans" ADD CONSTRAINT "haccp_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_plans" ADD CONSTRAINT "haccp_plans_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_steps" ADD CONSTRAINT "haccp_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_steps" ADD CONSTRAINT "haccp_steps_organization_id_plan_id_fkey" FOREIGN KEY ("organization_id", "plan_id") REFERENCES "haccp_plans"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_hazards" ADD CONSTRAINT "haccp_hazards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_hazards" ADD CONSTRAINT "haccp_hazards_organization_id_plan_id_fkey" FOREIGN KEY ("organization_id", "plan_id") REFERENCES "haccp_plans"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_hazards" ADD CONSTRAINT "haccp_hazards_organization_id_step_id_fkey" FOREIGN KEY ("organization_id", "step_id") REFERENCES "haccp_steps"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_control_points" ADD CONSTRAINT "haccp_control_points_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_control_points" ADD CONSTRAINT "haccp_control_points_organization_id_plan_id_fkey" FOREIGN KEY ("organization_id", "plan_id") REFERENCES "haccp_plans"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_control_points" ADD CONSTRAINT "haccp_control_points_organization_id_hazard_id_fkey" FOREIGN KEY ("organization_id", "hazard_id") REFERENCES "haccp_hazards"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_control_point_checkpoints" ADD CONSTRAINT "haccp_control_point_checkpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_control_point_checkpoints" ADD CONSTRAINT "haccp_control_point_checkpoints_organization_id_control_po_fkey" FOREIGN KEY ("organization_id", "control_point_id") REFERENCES "haccp_control_points"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "haccp_control_point_checkpoints" ADD CONSTRAINT "haccp_control_point_checkpoints_organization_id_checkpoint_fkey" FOREIGN KEY ("organization_id", "checkpoint_id") REFERENCES "safety_checkpoints"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ─── C2a HACCP plans (ADR-096): hand-written rules ───

ALTER TABLE "haccp_plans" ADD CONSTRAINT "haccp_plans_text"
  CHECK (length(btrim("code")) > 0 AND length(btrim("name")) > 0 AND length(btrim("scope")) > 0 AND "version" >= 1);
ALTER TABLE "haccp_plans" ADD CONSTRAINT "haccp_plans_state" CHECK (
  ("status" = 'DRAFT') = ("approved_at" IS NULL)
  AND ("approved_at" IS NULL) = ("approved_by_user_id" IS NULL)
  AND ("approved_by_user_id" IS NULL OR "approved_by_user_id" <> "created_by_user_id")
  AND ("status" = 'SUPERSEDED') = ("superseded_at" IS NOT NULL));
-- One approved version of a plan at a time.
CREATE UNIQUE INDEX "haccp_plans_one_approved" ON "haccp_plans" ("organization_id", "code") WHERE "status" = 'APPROVED';
-- One draft at a time.
CREATE UNIQUE INDEX "haccp_plans_one_draft" ON "haccp_plans" ("organization_id", "code") WHERE "status" = 'DRAFT';

ALTER TABLE "haccp_steps" ADD CONSTRAINT "haccp_steps_ck" CHECK ("position" >= 1 AND length(btrim("name")) > 0);
ALTER TABLE "haccp_hazards" ADD CONSTRAINT "haccp_hazards_scores"
  CHECK ("likelihood" BETWEEN 1 AND 5 AND "severity" BETWEEN 1 AND 5 AND length(btrim("description")) > 0);
ALTER TABLE "haccp_hazards" ADD CONSTRAINT "haccp_hazards_justified"
  CHECK ("tree_result" IS NULL OR "classification" = "tree_result"
         OR length(btrim(coalesce("justification", ''))) > 0);
ALTER TABLE "haccp_control_points" ADD CONSTRAINT "haccp_control_points_ck"
  CHECK ("min_value" IS NULL OR "max_value" IS NULL OR "min_value" <= "max_value");

-- A plan is fixed once it leaves draft; the only later change is being superseded.
CREATE FUNCTION haccp_plan_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED'
     AND (to_jsonb(NEW) - 'status' - 'superseded_at' - 'updated_at')
       = (to_jsonb(OLD) - 'status' - 'superseded_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an approved HACCP plan cannot change; start a new version' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "haccp_plans_fixed" BEFORE UPDATE ON "haccp_plans"
  FOR EACH ROW EXECUTE FUNCTION haccp_plan_fixed();

-- Steps, hazards, control points and their checkpoints change only in a
-- draft plan, and always belong to the same plan as their parent.
CREATE FUNCTION haccp_child_in_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rec RECORD;
  org uuid;
  plan uuid;
  st "HaccpPlanStatus";
BEGIN
  -- Field references are kept per table: PL/pgSQL plans whole expressions.
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  org := rec."organization_id";
  IF TG_TABLE_NAME = 'haccp_control_point_checkpoints' THEN
    SELECT cp."plan_id" INTO plan FROM "haccp_control_points" cp
     WHERE cp."organization_id" = org AND cp."id" = rec."control_point_id";
  ELSE
    plan := rec."plan_id";
  END IF;
  SELECT p."status" INTO st FROM "haccp_plans" p WHERE p."organization_id" = org AND p."id" = plan;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'only a draft HACCP plan can be edited' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'haccp_hazards' THEN
      IF NOT EXISTS (SELECT 1 FROM "haccp_steps" s
                     WHERE s."organization_id" = org AND s."id" = rec."step_id" AND s."plan_id" = plan) THEN
        RAISE EXCEPTION 'the hazard''s step is in another plan' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF TG_TABLE_NAME = 'haccp_control_points' THEN
      IF NOT EXISTS (SELECT 1 FROM "haccp_hazards" h
                     WHERE h."organization_id" = org AND h."id" = rec."hazard_id"
                       AND h."plan_id" = plan AND h."classification" IN ('CCP', 'OPRP')) THEN
        RAISE EXCEPTION 'a control point is for a CCP or OPRP hazard of the same plan' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN rec;
END;
$$;
CREATE TRIGGER "haccp_steps_draft" BEFORE INSERT OR UPDATE OR DELETE ON "haccp_steps"
  FOR EACH ROW EXECUTE FUNCTION haccp_child_in_draft();
CREATE TRIGGER "haccp_hazards_draft" BEFORE INSERT OR UPDATE OR DELETE ON "haccp_hazards"
  FOR EACH ROW EXECUTE FUNCTION haccp_child_in_draft();
CREATE TRIGGER "haccp_control_points_draft" BEFORE INSERT OR UPDATE OR DELETE ON "haccp_control_points"
  FOR EACH ROW EXECUTE FUNCTION haccp_child_in_draft();
CREATE TRIGGER "haccp_control_point_checkpoints_draft" BEFORE INSERT OR UPDATE OR DELETE ON "haccp_control_point_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION haccp_child_in_draft();

GRANT SELECT, INSERT, UPDATE ON "haccp_plans" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "haccp_steps", "haccp_hazards", "haccp_control_points", "haccp_control_point_checkpoints" TO fa_tenant;
ALTER TABLE "haccp_plans" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "haccp_plans" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "haccp_steps" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "haccp_steps" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "haccp_hazards" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "haccp_hazards" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "haccp_control_points" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "haccp_control_points" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "haccp_control_point_checkpoints" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "haccp_control_point_checkpoints" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
