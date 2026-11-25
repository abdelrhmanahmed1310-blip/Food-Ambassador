-- ADR-156: products dropped from agent order suggestions, with a reason; repeated drops pause the product.
-- CreateTable
CREATE TABLE "agent_line_drops" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "dropped_by_user_id" UUID NOT NULL,
    "dropped_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pause_lifted_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_line_drops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_line_drops_organization_id_agent_id_warehouse_id_prod_idx" ON "agent_line_drops"("organization_id", "agent_id", "warehouse_id", "product_id", "dropped_at");

-- AddForeignKey
ALTER TABLE "agent_line_drops" ADD CONSTRAINT "agent_line_drops_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_line_drops" ADD CONSTRAINT "agent_line_drops_organization_id_agent_id_fkey" FOREIGN KEY ("organization_id", "agent_id") REFERENCES "agents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_line_drops" ADD CONSTRAINT "agent_line_drops_organization_id_proposal_id_fkey" FOREIGN KEY ("organization_id", "proposal_id") REFERENCES "agent_proposals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (ADR-156) --------------------------------------------------------
ALTER TABLE "agent_line_drops" ADD CONSTRAINT "agent_line_drops_reason_check"
  CHECK ("reason" IN ('NOT_NEEDED', 'ALREADY_DONE', 'WRONG_AMOUNT', 'WRONG_DATA', 'BAD_TIMING', 'OTHER'));
ALTER TABLE "agent_line_drops" ADD CONSTRAINT "agent_line_drops_note_check"
  CHECK ("reason" <> 'OTHER' OR coalesce(btrim("note"), '') <> '');
ALTER TABLE "agent_line_drops" ADD CONSTRAINT "agent_line_drops_warehouse_fkey"
  FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "agent_line_drops" ADD CONSTRAINT "agent_line_drops_product_fkey"
  FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT;
GRANT SELECT, INSERT, UPDATE ON "agent_line_drops" TO fa_tenant;
ALTER TABLE "agent_line_drops" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agent_line_drops" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
