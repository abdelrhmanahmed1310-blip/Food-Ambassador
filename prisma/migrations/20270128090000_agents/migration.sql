-- AgaaS Phase 0 (ADR-140): agents, their runs and their proposals.
-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('REPLENISHMENT', 'DAILY_CLOSE');

-- CreateEnum
CREATE TYPE "AgentAutonomy" AS ENUM ('SUGGEST', 'DRAFT');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentRunTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "AgentProposalStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "AgentKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autonomy" "AgentAutonomy" NOT NULL DEFAULT 'SUGGEST',
    "run_hour" INTEGER NOT NULL DEFAULT 6,
    "run_as_user_id" UUID,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "last_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "trigger" "AgentRunTrigger" NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "business_date" DATE,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "tool_calls" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "started_by_user_id" UUID,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_proposals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "AgentProposalStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "warehouse_id" UUID,
    "entity_type" TEXT,
    "entity_id" UUID,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_organization_id_id_key" ON "agents"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_organization_id_kind_key" ON "agents"("organization_id", "kind");

-- CreateIndex
CREATE INDEX "agent_runs_organization_id_agent_id_started_at_idx" ON "agent_runs"("organization_id", "agent_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_organization_id_id_key" ON "agent_runs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "agent_proposals_organization_id_status_created_at_idx" ON "agent_proposals"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_proposals_organization_id_id_key" ON "agent_proposals"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_organization_id_agent_id_fkey" FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_organization_id_agent_id_fkey" FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "agent_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Checks the service makes first.
ALTER TABLE "agents" ADD CONSTRAINT "agents_run_hour_check" CHECK ("run_hour" BETWEEN 0 AND 23);
-- Switched on only with someone whose access it uses.
ALTER TABLE "agents" ADD CONSTRAINT "agents_run_as_check" CHECK (NOT "enabled" OR "run_as_user_id" IS NOT NULL);
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_finished_check"
  CHECK (("status" = 'RUNNING') = ("finished_at" IS NULL));
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_decided_check"
  CHECK (("status" IN ('OPEN', 'SUPERSEDED')) = ("decided_at" IS NULL) OR "status" = 'SUPERSEDED');

-- Tenant isolation; runs and proposals are a record: never deleted.
GRANT SELECT, INSERT, UPDATE ON "agents", "agent_runs", "agent_proposals" TO fa_tenant;
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_proposals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agents"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
CREATE POLICY "tenant_isolation" ON "agent_runs"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
CREATE POLICY "tenant_isolation" ON "agent_proposals"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
