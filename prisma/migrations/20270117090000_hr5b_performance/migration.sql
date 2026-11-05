-- HR5b: goals and performance reviews (DECISIONS.md ADR-126).

-- CreateEnum
CREATE TYPE "PerformanceCycleStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PerformanceGoalStatus" AS ENUM ('OPEN', 'ACHIEVED', 'PARTLY_ACHIEVED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PerformanceReviewStatus" AS ENUM ('NOT_STARTED', 'SELF_DONE', 'MANAGER_DONE', 'ACKNOWLEDGED', 'FINALIZED', 'SKIPPED');

-- CreateTable
CREATE TABLE "performance_cycles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "branch_id" UUID,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "self_due_on" DATE NOT NULL,
    "manager_due_on" DATE NOT NULL,
    "status" "PerformanceCycleStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "launched_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "performance_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_goals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "cycle_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL,
    "due_on" DATE,
    "status" "PerformanceGoalStatus" NOT NULL DEFAULT 'OPEN',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "performance_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_reviews" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "reviewer_employee_id" UUID,
    "status" "PerformanceReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "self_comment" TEXT,
    "self_submitted_at" TIMESTAMPTZ(3),
    "manager_rating" INTEGER,
    "manager_strengths" TEXT,
    "manager_improvements" TEXT,
    "manager_submitted_at" TIMESTAMPTZ(3),
    "manager_submitted_user_id" UUID,
    "employee_comment" TEXT,
    "acknowledged_at" TIMESTAMPTZ(3),
    "final_rating" INTEGER,
    "final_reason" TEXT,
    "finalized_at" TIMESTAMPTZ(3),
    "finalized_by_user_id" UUID,
    "skip_reason" TEXT,

    CONSTRAINT "performance_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_review_goals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "self_rating" INTEGER,
    "manager_rating" INTEGER,
    "comment" TEXT,

    CONSTRAINT "performance_review_goals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "performance_cycles_organization_id_id_key" ON "performance_cycles"("organization_id", "id");

-- CreateIndex
CREATE INDEX "performance_goals_organization_id_employee_id_cycle_id_idx" ON "performance_goals"("organization_id", "employee_id", "cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_goals_organization_id_id_key" ON "performance_goals"("organization_id", "id");

-- CreateIndex
CREATE INDEX "performance_reviews_organization_id_reviewer_employee_id_idx" ON "performance_reviews"("organization_id", "reviewer_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_reviews_organization_id_id_key" ON "performance_reviews"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_reviews_organization_id_cycle_id_employee_id_key" ON "performance_reviews"("organization_id", "cycle_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_review_goals_organization_id_review_id_goal_id_key" ON "performance_review_goals"("organization_id", "review_id", "goal_id");

-- AddForeignKey
ALTER TABLE "performance_cycles" ADD CONSTRAINT "performance_cycles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_organization_id_cycle_id_fkey" FOREIGN KEY ("organization_id", "cycle_id") REFERENCES "performance_cycles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_organization_id_cycle_id_fkey" FOREIGN KEY ("organization_id", "cycle_id") REFERENCES "performance_cycles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_organization_id_reviewer_employee_id_fkey" FOREIGN KEY ("organization_id", "reviewer_employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_review_goals" ADD CONSTRAINT "performance_review_goals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_review_goals" ADD CONSTRAINT "performance_review_goals_organization_id_review_id_fkey" FOREIGN KEY ("organization_id", "review_id") REFERENCES "performance_reviews"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_review_goals" ADD CONSTRAINT "performance_review_goals_organization_id_goal_id_fkey" FOREIGN KEY ("organization_id", "goal_id") REFERENCES "performance_goals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── HR5b performance (ADR-126): hand-written rules ───
ALTER TABLE "performance_cycles" ADD CONSTRAINT "performance_cycles_ck" CHECK (
  length("name") BETWEEN 1 AND 120 AND "period_end" >= "period_start"
  AND "manager_due_on" >= "self_due_on"
  AND ("status" = 'DRAFT' OR "launched_at" IS NOT NULL)
  AND ("status" <> 'CLOSED' OR "closed_at" IS NOT NULL));
ALTER TABLE "performance_goals" ADD CONSTRAINT "performance_goals_ck" CHECK (
  length("title") BETWEEN 1 AND 200 AND "weight" BETWEEN 0 AND 100 AND "progress" BETWEEN 0 AND 100);
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_ck" CHECK (
  ("manager_rating" IS NULL OR "manager_rating" BETWEEN 1 AND 5)
  AND ("final_rating" IS NULL OR "final_rating" BETWEEN 1 AND 5)
  AND ("status" NOT IN ('MANAGER_DONE', 'ACKNOWLEDGED', 'FINALIZED') OR "manager_rating" IS NOT NULL)
  AND ("status" <> 'FINALIZED' OR "final_rating" IS NOT NULL)
  AND ("status" <> 'SKIPPED' OR "skip_reason" IS NOT NULL));
ALTER TABLE "performance_review_goals" ADD CONSTRAINT "performance_review_goals_ck" CHECK (
  ("self_rating" IS NULL OR "self_rating" BETWEEN 1 AND 5)
  AND ("manager_rating" IS NULL OR "manager_rating" BETWEEN 1 AND 5));

-- A finalized or skipped review is the record of the cycle: it no longer changes.
CREATE OR REPLACE FUNCTION "performance_reviews_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('FINALIZED', 'SKIPPED') THEN
    RAISE EXCEPTION 'a finalized review cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "performance_reviews_fixed" BEFORE UPDATE ON "performance_reviews"
  FOR EACH ROW EXECUTE FUNCTION "performance_reviews_fixed"();
CREATE OR REPLACE FUNCTION "performance_review_goals_open"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "PerformanceReviewStatus";
BEGIN
  SELECT "status" INTO s FROM "performance_reviews" WHERE "id" = COALESCE(NEW."review_id", OLD."review_id");
  IF s IN ('FINALIZED', 'SKIPPED') THEN
    RAISE EXCEPTION 'a finalized review cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER "performance_review_goals_open" BEFORE INSERT OR UPDATE OR DELETE ON "performance_review_goals"
  FOR EACH ROW EXECUTE FUNCTION "performance_review_goals_open"();

GRANT SELECT, INSERT, UPDATE ON "performance_cycles", "performance_goals", "performance_reviews" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "performance_review_goals" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['performance_cycles', 'performance_goals', 'performance_reviews',
    'performance_review_goals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'performance.view'), ('admin', 'performance.manage'),
             ('operations_manager', 'performance.view'), ('operations_manager', 'performance.manage'),
             ('branch_manager', 'performance.view'), ('branch_manager', 'performance.manage'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
