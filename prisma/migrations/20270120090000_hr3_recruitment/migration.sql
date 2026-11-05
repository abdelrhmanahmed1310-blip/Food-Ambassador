-- HR3: recruitment and workforce planning (DECISIONS.md ADR-129).

-- CreateEnum
CREATE TYPE "JobOpeningStatus" AS ENUM ('PENDING_APPROVAL', 'OPEN', 'FILLED', 'CLOSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "JobOpeningReason" AS ENUM ('NEW_POSITION', 'REPLACEMENT', 'SEASONAL');

-- CreateEnum
CREATE TYPE "CandidateSource" AS ENUM ('REFERRAL', 'JOB_BOARD', 'WALK_IN', 'AGENCY', 'SOCIAL_MEDIA', 'OTHER');

-- CreateEnum
CREATE TYPE "ApplicationStage" AS ENUM ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "InterviewKind" AS ENUM ('IN_PERSON', 'PHONE', 'VIDEO', 'TRIAL_SHIFT');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InterviewRecommendation" AS ENUM ('HIRE', 'NO_HIRE', 'UNSURE');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'CANDIDATE';

-- CreateTable
CREATE TABLE "recruitment_settings" (
    "organization_id" UUID NOT NULL,
    "candidate_retention_days" INTEGER,
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recruitment_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "workforce_positions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "job_title" TEXT NOT NULL,
    "title_key" TEXT NOT NULL,
    "planned_headcount" INTEGER NOT NULL,
    "note" TEXT,
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workforce_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_openings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "job_title" TEXT NOT NULL,
    "title_key" TEXT NOT NULL,
    "employment_type" "EmploymentType" NOT NULL,
    "headcount" INTEGER NOT NULL,
    "reason" "JobOpeningReason" NOT NULL,
    "description" TEXT,
    "target_start_on" DATE,
    "status" "JobOpeningStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "beyond_plan" INTEGER NOT NULL DEFAULT 0,
    "requested_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "hired" INTEGER NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,

    CONSTRAINT "job_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "source" "CandidateSource" NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ(3),

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "opening_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "stage" "ApplicationStage" NOT NULL DEFAULT 'APPLIED',
    "stage_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "close_note" TEXT,
    "employee_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_stage" "ApplicationStage",
    "to_stage" "ApplicationStage" NOT NULL,
    "note" TEXT,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "kind" "InterviewKind" NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "location" TEXT,
    "interviewer_user_id" UUID NOT NULL,
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "rating" INTEGER,
    "recommendation" "InterviewRecommendation",
    "notes" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workforce_positions_organization_id_branch_id_title_key_key" ON "workforce_positions"("organization_id", "branch_id", "title_key");

-- CreateIndex
CREATE INDEX "job_openings_organization_id_status_idx" ON "job_openings"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_openings_organization_id_id_key" ON "job_openings"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_openings_organization_id_number_key" ON "job_openings"("organization_id", "number");

-- CreateIndex
CREATE INDEX "candidates_organization_id_last_activity_at_idx" ON "candidates"("organization_id", "last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_organization_id_id_key" ON "candidates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_employee_id_key" ON "job_applications"("employee_id");

-- CreateIndex
CREATE INDEX "job_applications_organization_id_stage_idx" ON "job_applications"("organization_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_organization_id_id_key" ON "job_applications"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_organization_id_employee_id_key" ON "job_applications"("organization_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_organization_id_opening_id_candidate_id_key" ON "job_applications"("organization_id", "opening_id", "candidate_id");

-- CreateIndex
CREATE INDEX "application_events_organization_id_application_id_at_idx" ON "application_events"("organization_id", "application_id", "at");

-- CreateIndex
CREATE INDEX "interviews_organization_id_interviewer_user_id_status_idx" ON "interviews"("organization_id", "interviewer_user_id", "status");

-- CreateIndex
CREATE INDEX "interviews_organization_id_application_id_idx" ON "interviews"("organization_id", "application_id");

-- AddForeignKey
ALTER TABLE "recruitment_settings" ADD CONSTRAINT "recruitment_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_positions" ADD CONSTRAINT "workforce_positions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_positions" ADD CONSTRAINT "workforce_positions_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_organization_id_department_id_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_organization_id_opening_id_fkey" FOREIGN KEY ("organization_id", "opening_id") REFERENCES "job_openings"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_organization_id_candidate_id_fkey" FOREIGN KEY ("organization_id", "candidate_id") REFERENCES "candidates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "job_applications"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_organization_id_application_id_fkey" FOREIGN KEY ("organization_id", "application_id") REFERENCES "job_applications"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_interviewer_user_id_fkey" FOREIGN KEY ("interviewer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── HR3 recruitment (ADR-129): hand-written rules ───
ALTER TABLE "recruitment_settings" ADD CONSTRAINT "recruitment_settings_ck" CHECK (
  "candidate_retention_days" IS NULL OR "candidate_retention_days" BETWEEN 30 AND 3650);
ALTER TABLE "workforce_positions" ADD CONSTRAINT "workforce_positions_ck" CHECK (
  "planned_headcount" BETWEEN 0 AND 10000 AND length("job_title") BETWEEN 1 AND 120);
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_ck" CHECK (
  "headcount" BETWEEN 1 AND 500 AND "hired" BETWEEN 0 AND "headcount" AND "beyond_plan" >= 0
  AND length("job_title") BETWEEN 1 AND 120
  AND ("status" = 'PENDING_APPROVAL' OR "decided_at" IS NOT NULL)
  AND ("status" <> 'FILLED' OR "hired" = "headcount")
  AND ("status" NOT IN ('CLOSED', 'FILLED') OR "closed_at" IS NOT NULL));
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_ck" CHECK (
  "erased_at" IS NOT NULL OR (length("first_name") BETWEEN 1 AND 80 AND length("last_name") BETWEEN 1 AND 80));
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_ck" CHECK (
  ("stage" = 'HIRED') = ("employee_id" IS NOT NULL));
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_ck" CHECK (
  ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
  AND ("status" = 'DONE') = ("submitted_at" IS NOT NULL)
  AND ("status" <> 'DONE' OR ("rating" IS NOT NULL AND "recommendation" IS NOT NULL)));
-- One live record per e-mail address among candidates not erased.
CREATE UNIQUE INDEX "candidates_email_key" ON "candidates" ("organization_id", lower("email"))
  WHERE "email" IS NOT NULL AND "erased_at" IS NULL;
-- A hired application is final.
CREATE OR REPLACE FUNCTION "job_applications_final"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."stage" IN ('HIRED', 'REJECTED', 'WITHDRAWN') AND NEW."stage" IS DISTINCT FROM OLD."stage" THEN
    RAISE EXCEPTION 'a closed application cannot move' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "job_applications_final" BEFORE UPDATE ON "job_applications"
  FOR EACH ROW EXECUTE FUNCTION "job_applications_final"();

GRANT SELECT, INSERT, UPDATE ON "recruitment_settings", "workforce_positions", "job_openings",
  "candidates", "job_applications", "interviews" TO fa_tenant;
GRANT SELECT, INSERT ON "application_events" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recruitment_settings', 'workforce_positions', 'job_openings', 'candidates',
    'job_applications', 'application_events', 'interviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'recruitment.view'), ('admin', 'recruitment.manage'),
             ('operations_manager', 'recruitment.view'), ('operations_manager', 'recruitment.manage'),
             ('branch_manager', 'recruitment.view'), ('branch_manager', 'recruitment.manage'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
