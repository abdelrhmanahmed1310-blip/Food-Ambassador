-- HR5a: training and certification (DECISIONS.md ADR-125).

-- CreateEnum
CREATE TYPE "TrainingCategory" AS ENUM ('FOOD_SAFETY', 'ALLERGENS', 'HYGIENE', 'HEALTH_SAFETY', 'FIRE_SAFETY', 'FIRST_AID', 'EQUIPMENT', 'SERVICE', 'ONBOARDING', 'OTHER');

-- CreateEnum
CREATE TYPE "TrainingDelivery" AS ENUM ('IN_PERSON', 'ONLINE', 'ON_THE_JOB');

-- CreateEnum
CREATE TYPE "TrainingScope" AS ENUM ('ALL', 'JOB_TITLE', 'DEPARTMENT', 'BRANCH');

-- CreateEnum
CREATE TYPE "TrainingSessionStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrainingAttendance" AS ENUM ('INVITED', 'ATTENDED', 'ABSENT');

-- CreateEnum
CREATE TYPE "TrainingResult" AS ENUM ('PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "TrainingRecordSource" AS ENUM ('SESSION', 'EXTERNAL');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'TRAINING_RECORD';

-- CreateTable
CREATE TABLE "training_courses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "category" "TrainingCategory" NOT NULL,
    "delivery" "TrainingDelivery" NOT NULL,
    "validity_months" INTEGER,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_requirements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "scope" "TrainingScope" NOT NULL,
    "job_title" TEXT,
    "department_id" UUID,
    "branch_id" UUID,
    "due_within_days" INTEGER NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "course_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "location" TEXT,
    "trainer" TEXT NOT NULL,
    "capacity" INTEGER,
    "status" "TrainingSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_user_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_participants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "attendance" "TrainingAttendance" NOT NULL DEFAULT 'INVITED',
    "result" "TrainingResult",
    "note" TEXT,

    CONSTRAINT "training_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "completed_on" DATE NOT NULL,
    "expires_on" DATE,
    "source" "TrainingRecordSource" NOT NULL,
    "session_id" UUID,
    "provider" TEXT,
    "certificate_number" TEXT,
    "note" TEXT,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "void_reason" TEXT,

    CONSTRAINT "training_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "training_courses_organization_id_id_key" ON "training_courses"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "training_courses_organization_id_code_key" ON "training_courses"("organization_id", "code");

-- CreateIndex
CREATE INDEX "training_requirements_organization_id_course_id_idx" ON "training_requirements"("organization_id", "course_id");

-- CreateIndex
CREATE INDEX "training_sessions_organization_id_branch_id_starts_at_idx" ON "training_sessions"("organization_id", "branch_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "training_sessions_organization_id_id_key" ON "training_sessions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "training_sessions_organization_id_number_key" ON "training_sessions"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "training_participants_organization_id_session_id_employee_i_key" ON "training_participants"("organization_id", "session_id", "employee_id");

-- CreateIndex
CREATE INDEX "training_records_organization_id_employee_id_course_id_idx" ON "training_records"("organization_id", "employee_id", "course_id");

-- CreateIndex
CREATE INDEX "training_records_organization_id_expires_on_idx" ON "training_records"("organization_id", "expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "training_records_organization_id_id_key" ON "training_records"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "training_courses" ADD CONSTRAINT "training_courses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_requirements" ADD CONSTRAINT "training_requirements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_requirements" ADD CONSTRAINT "training_requirements_organization_id_course_id_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "training_courses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_organization_id_course_id_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "training_courses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_participants" ADD CONSTRAINT "training_participants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_participants" ADD CONSTRAINT "training_participants_organization_id_session_id_fkey" FOREIGN KEY ("organization_id", "session_id") REFERENCES "training_sessions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_participants" ADD CONSTRAINT "training_participants_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_organization_id_course_id_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "training_courses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_organization_id_session_id_fkey" FOREIGN KEY ("organization_id", "session_id") REFERENCES "training_sessions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── HR5a learning (ADR-125): hand-written rules ───
ALTER TABLE "training_courses" ADD CONSTRAINT "training_courses_ck" CHECK (
  "code" ~ '^[A-Z][A-Z0-9_-]{0,19}$' AND length("name") BETWEEN 1 AND 120
  AND ("validity_months" IS NULL OR "validity_months" BETWEEN 1 AND 120));
ALTER TABLE "training_requirements" ADD CONSTRAINT "training_requirements_ck" CHECK (
  "due_within_days" BETWEEN 0 AND 365
  AND (("scope" = 'ALL' AND "job_title" IS NULL AND "department_id" IS NULL AND "branch_id" IS NULL)
    OR ("scope" = 'JOB_TITLE' AND "job_title" IS NOT NULL AND "department_id" IS NULL AND "branch_id" IS NULL)
    OR ("scope" = 'DEPARTMENT' AND "department_id" IS NOT NULL AND "job_title" IS NULL AND "branch_id" IS NULL)
    OR ("scope" = 'BRANCH' AND "branch_id" IS NOT NULL AND "job_title" IS NULL AND "department_id" IS NULL)));
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_ck" CHECK (
  ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 500)
  AND ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL));
ALTER TABLE "training_participants" ADD CONSTRAINT "training_participants_ck" CHECK (
  "result" IS NULL OR "attendance" = 'ATTENDED');
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_ck" CHECK (
  ("expires_on" IS NULL OR "expires_on" >= "completed_on")
  AND ("source" <> 'SESSION' OR "session_id" IS NOT NULL)
  AND ("voided_at" IS NULL OR "void_reason" IS NOT NULL));

-- A training record is a record: only voiding may change it.
CREATE OR REPLACE FUNCTION "training_records_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."voided_at" IS NOT NULL
     OR NEW."employee_id" <> OLD."employee_id" OR NEW."course_id" <> OLD."course_id"
     OR NEW."completed_on" <> OLD."completed_on" OR NEW."expires_on" IS DISTINCT FROM OLD."expires_on"
     OR NEW."source" <> OLD."source" OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."certificate_number" IS DISTINCT FROM OLD."certificate_number" THEN
    RAISE EXCEPTION 'training records cannot be changed, only voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "training_records_fixed" BEFORE UPDATE ON "training_records"
  FOR EACH ROW EXECUTE FUNCTION "training_records_fixed"();

-- A completed or cancelled session no longer changes, nor do its participants.
CREATE OR REPLACE FUNCTION "training_participants_open"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "TrainingSessionStatus";
BEGIN
  SELECT "status" INTO s FROM "training_sessions" WHERE "id" = COALESCE(NEW."session_id", OLD."session_id");
  IF s IS DISTINCT FROM 'SCHEDULED' THEN
    RAISE EXCEPTION 'the training session is closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER "training_participants_open" BEFORE INSERT OR UPDATE OR DELETE ON "training_participants"
  FOR EACH ROW EXECUTE FUNCTION "training_participants_open"();

GRANT SELECT, INSERT, UPDATE ON "training_courses", "training_sessions", "training_records" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "training_requirements" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "training_participants" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['training_courses', 'training_requirements', 'training_sessions',
    'training_participants', 'training_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'training.view'), ('admin', 'training.manage'),
             ('operations_manager', 'training.view'), ('operations_manager', 'training.manage'),
             ('branch_manager', 'training.view'), ('branch_manager', 'training.manage'),
             ('food_safety', 'training.view'), ('food_safety', 'training.manage'),
             ('analyst', 'training.view'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
