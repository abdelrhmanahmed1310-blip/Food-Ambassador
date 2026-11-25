-- ADR-157: the weekdays each agent runs on.
-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "run_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6, 7]::INTEGER[];

-- Hand-written (ADR-157) --------------------------------------------------------
-- At least one day, ISO weekdays only.
ALTER TABLE "agents" ADD CONSTRAINT "agents_run_days_check"
  CHECK ("run_days" IS NOT NULL AND cardinality("run_days") BETWEEN 1 AND 7
    AND "run_days" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]);
