-- ADR-142: invoice matching, food safety and menu & margin agents.
-- AlterEnum
ALTER TYPE "AgentKind" ADD VALUE 'INVOICE_MATCHING';
ALTER TYPE "AgentKind" ADD VALUE 'FOOD_SAFETY';
ALTER TYPE "AgentKind" ADD VALUE 'MENU_MARGIN';

-- AlterTable
ALTER TABLE "agent_proposals" ADD COLUMN     "branch_id" UUID;

-- Proposal kinds the inbox knows how to carry out.
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_kind_check"
  CHECK ("kind" IN ('PURCHASE_ORDER', 'REORDER', 'CREDIT_REQUEST', 'RAISE_NC', 'PRICE_CHANGE'));

CREATE INDEX "agent_proposals_entity_idx" ON "agent_proposals"("organization_id", "agent_id", "entity_id");
