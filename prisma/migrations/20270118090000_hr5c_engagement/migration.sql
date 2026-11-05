-- HR5c: anonymous surveys and recognition (DECISIONS.md ADR-127).

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SurveyQuestionType" AS ENUM ('RATING', 'ENPS', 'YES_NO', 'TEXT');

-- CreateEnum
CREATE TYPE "RecognitionValue" AS ENUM ('TEAMWORK', 'GUEST_SERVICE', 'FOOD_SAFETY', 'CLEANLINESS', 'LEADERSHIP', 'EXTRA_MILE');

-- CreateTable
CREATE TABLE "engagement_surveys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT,
    "branch_id" UUID,
    "status" "SurveyStatus" NOT NULL DEFAULT 'DRAFT',
    "closes_on" DATE,
    "audience_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "engagement_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_questions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "SurveyQuestionType" NOT NULL,
    "text" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "engagement_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "submitted_on" DATE NOT NULL,

    CONSTRAINT "engagement_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "value" INTEGER,
    "text" TEXT,

    CONSTRAINT "engagement_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_participations" (
    "organization_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,

    CONSTRAINT "engagement_participations_pkey" PRIMARY KEY ("organization_id","survey_id","employee_id")
);

-- CreateTable
CREATE TABLE "recognitions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "from_employee_id" UUID NOT NULL,
    "to_employee_id" UUID NOT NULL,
    "value" "RecognitionValue" NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hidden_at" TIMESTAMPTZ(3),
    "hidden_by_user_id" UUID,
    "hidden_reason" TEXT,

    CONSTRAINT "recognitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "engagement_surveys_organization_id_id_key" ON "engagement_surveys"("organization_id", "id");

-- CreateIndex
CREATE INDEX "engagement_questions_organization_id_survey_id_position_idx" ON "engagement_questions"("organization_id", "survey_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_questions_organization_id_id_key" ON "engagement_questions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "engagement_responses_organization_id_survey_id_idx" ON "engagement_responses"("organization_id", "survey_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_responses_organization_id_id_key" ON "engagement_responses"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_answers_organization_id_response_id_question_id_key" ON "engagement_answers"("organization_id", "response_id", "question_id");

-- CreateIndex
CREATE INDEX "recognitions_organization_id_created_at_idx" ON "recognitions"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "recognitions_organization_id_to_employee_id_idx" ON "recognitions"("organization_id", "to_employee_id");

-- AddForeignKey
ALTER TABLE "engagement_surveys" ADD CONSTRAINT "engagement_surveys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_questions" ADD CONSTRAINT "engagement_questions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_questions" ADD CONSTRAINT "engagement_questions_organization_id_survey_id_fkey" FOREIGN KEY ("organization_id", "survey_id") REFERENCES "engagement_surveys"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_responses" ADD CONSTRAINT "engagement_responses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_responses" ADD CONSTRAINT "engagement_responses_organization_id_survey_id_fkey" FOREIGN KEY ("organization_id", "survey_id") REFERENCES "engagement_surveys"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_answers" ADD CONSTRAINT "engagement_answers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_answers" ADD CONSTRAINT "engagement_answers_organization_id_response_id_fkey" FOREIGN KEY ("organization_id", "response_id") REFERENCES "engagement_responses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_answers" ADD CONSTRAINT "engagement_answers_organization_id_question_id_fkey" FOREIGN KEY ("organization_id", "question_id") REFERENCES "engagement_questions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_participations" ADD CONSTRAINT "engagement_participations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_participations" ADD CONSTRAINT "engagement_participations_organization_id_survey_id_fkey" FOREIGN KEY ("organization_id", "survey_id") REFERENCES "engagement_surveys"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_participations" ADD CONSTRAINT "engagement_participations_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_organization_id_from_employee_id_fkey" FOREIGN KEY ("organization_id", "from_employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_organization_id_to_employee_id_fkey" FOREIGN KEY ("organization_id", "to_employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── HR5c engagement (ADR-127): hand-written rules ───
ALTER TABLE "engagement_surveys" ADD CONSTRAINT "engagement_surveys_ck" CHECK (
  length("title") BETWEEN 1 AND 160
  AND ("status" = 'DRAFT' OR "opened_at" IS NOT NULL)
  AND ("status" <> 'CLOSED' OR "closed_at" IS NOT NULL));
ALTER TABLE "engagement_questions" ADD CONSTRAINT "engagement_questions_ck" CHECK (
  length("text") BETWEEN 1 AND 300 AND "position" BETWEEN 1 AND 50);
ALTER TABLE "engagement_answers" ADD CONSTRAINT "engagement_answers_ck" CHECK (
  ("value" IS NULL OR "value" BETWEEN 0 AND 10) AND ("text" IS NULL OR length("text") <= 2000)
  AND ("value" IS NOT NULL OR "text" IS NOT NULL));
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_ck" CHECK (
  "from_employee_id" <> "to_employee_id" AND length("message") BETWEEN 1 AND 500
  AND ("hidden_at" IS NULL OR "hidden_reason" IS NOT NULL));

-- Questions change only while the survey is a draft; answers only arrive while it is open.
CREATE OR REPLACE FUNCTION "engagement_questions_draft"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "SurveyStatus";
BEGIN
  SELECT "status" INTO s FROM "engagement_surveys" WHERE "id" = COALESCE(NEW."survey_id", OLD."survey_id");
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'the survey is no longer a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER "engagement_questions_draft" BEFORE INSERT OR UPDATE OR DELETE ON "engagement_questions"
  FOR EACH ROW EXECUTE FUNCTION "engagement_questions_draft"();
CREATE OR REPLACE FUNCTION "engagement_responses_open"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "SurveyStatus";
BEGIN
  SELECT "status" INTO s FROM "engagement_surveys" WHERE "id" = NEW."survey_id";
  IF s IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'the survey is not open' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "engagement_responses_open" BEFORE INSERT ON "engagement_responses"
  FOR EACH ROW EXECUTE FUNCTION "engagement_responses_open"();

-- Answers and participations are written once and never changed.
GRANT SELECT, INSERT, UPDATE ON "engagement_surveys", "recognitions" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "engagement_questions" TO fa_tenant;
GRANT SELECT, INSERT ON "engagement_responses", "engagement_answers", "engagement_participations" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['engagement_surveys', 'engagement_questions', 'engagement_responses',
    'engagement_answers', 'engagement_participations', 'recognitions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'engagement.view'), ('admin', 'engagement.manage'),
             ('operations_manager', 'engagement.view'), ('operations_manager', 'engagement.manage'),
             ('branch_manager', 'engagement.view'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
