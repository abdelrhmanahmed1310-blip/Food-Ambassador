-- ADR-155: rejection reasons pause repeat proposals; someone can lift the pause.
-- AlterTable
ALTER TABLE "agent_proposals" ADD COLUMN     "pause_lifted_at" TIMESTAMPTZ(3);

-- Hand-written (ADR-155) --------------------------------------------------------
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_pause_lifted_check"
  CHECK ("pause_lifted_at" IS NULL OR "status"::text = 'REJECTED');
