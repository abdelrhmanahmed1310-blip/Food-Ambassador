-- ADR-149: agents investigate their critical findings; follow-up proposals from investigations.
-- AlterTable
ALTER TABLE "agent_investigations" ADD COLUMN     "automatic" BOOLEAN NOT NULL DEFAULT false;

-- Hand-written (ADR-149) --------------------------------------------------------
ALTER TABLE "agent_proposals" DROP CONSTRAINT "agent_proposals_kind_check";
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_kind_check"
  CHECK ("kind" IN ('PURCHASE_ORDER', 'REORDER', 'CREDIT_REQUEST', 'RAISE_NC', 'PRICE_CHANGE', 'FOLLOW_UP'));
