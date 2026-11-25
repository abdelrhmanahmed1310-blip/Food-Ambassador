-- ADR-152: why a person rejected an agent proposal.
-- AlterTable
ALTER TABLE "agent_proposals" ADD COLUMN     "rejection_reason" TEXT;

-- Hand-written (ADR-152) --------------------------------------------------------
-- A reason from the fixed list, and only on a rejected proposal.
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_rejection_reason_check"
  CHECK ("rejection_reason" IS NULL OR (
    "rejection_reason" IN ('NOT_NEEDED', 'ALREADY_DONE', 'WRONG_AMOUNT', 'WRONG_DATA', 'BAD_TIMING', 'OTHER')
    AND "status"::text = 'REJECTED'));
