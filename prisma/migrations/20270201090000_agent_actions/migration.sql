-- ADR-145: agents act within limits, after a hold a person can stop, with a kill switch.
-- AlterEnum
ALTER TYPE "AgentAutonomy" ADD VALUE 'ACT';

-- AlterEnum
ALTER TYPE "AgentProposalStatus" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "agent_proposals" ADD COLUMN     "acted_by_agent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scheduled_for" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "agent_actions_paused_at" TIMESTAMPTZ(3),
ADD COLUMN     "agent_actions_paused_by_user_id" UUID;

-- Hand-written (ADR-145) --------------------------------------------------------
-- Statuses are compared as text: a value added above cannot be used in this transaction.
-- Open, scheduled and superseded proposals are undecided; approved and rejected ones are decided.
ALTER TABLE "agent_proposals" DROP CONSTRAINT "agent_proposals_decided_check";
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_decided_check"
  CHECK (("status"::text IN ('OPEN', 'SCHEDULED', 'SUPERSEDED')) = ("decided_at" IS NULL)
         OR "status"::text = 'SUPERSEDED');
-- A scheduled proposal says when; only an approved one can be the agent's own doing.
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_scheduled_check"
  CHECK ("status"::text <> 'SCHEDULED' OR "scheduled_for" IS NOT NULL);
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_acted_check"
  CHECK (NOT "acted_by_agent" OR "status"::text = 'APPROVED');
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_agent_pause_check"
  CHECK (("agent_actions_paused_at" IS NULL) = ("agent_actions_paused_by_user_id" IS NULL));
-- Scheduled actions due, for the job runner.
CREATE INDEX "agent_proposals_scheduled_idx" ON "agent_proposals"("status", "scheduled_for");
