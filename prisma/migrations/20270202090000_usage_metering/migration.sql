-- ADR-146: usage metering and the organization's own usage limits.
-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "usage_limits" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "usage_daily" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "quantity" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_daily_organization_id_day_metric_dimension_key" ON "usage_daily"("organization_id", "day", "metric", "dimension");

-- AddForeignKey
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (ADR-146) --------------------------------------------------------
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_quantity_check" CHECK ("quantity" >= 0);
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_metric_check" CHECK ("metric" IN (
  'agent.runs', 'agent.actions', 'agent.approvals', 'ai.input_tokens', 'ai.output_tokens', 'mcp.calls'));
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_usage_limits_check"
  CHECK (jsonb_typeof("usage_limits") = 'object');
-- Counters only grow; nothing is deleted.
GRANT SELECT, INSERT, UPDATE ON "usage_daily" TO fa_tenant;
ALTER TABLE "usage_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "usage_daily" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
