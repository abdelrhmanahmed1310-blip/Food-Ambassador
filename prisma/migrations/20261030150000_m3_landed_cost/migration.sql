-- CreateEnum
CREATE TYPE "LandedCostCharge" AS ENUM ('FREIGHT', 'CUSTOMS_DUTY', 'INSURANCE', 'HANDLING', 'OTHER');

-- CreateEnum
CREATE TYPE "LandedCostMethod" AS ENUM ('BY_VALUE', 'BY_QUANTITY');

-- AlterEnum
ALTER TYPE "InventoryDocumentType" ADD VALUE 'LANDED_COST';

-- CreateTable
CREATE TABLE "landed_costs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "charge_type" "LandedCostCharge" NOT NULL,
    "method" "LandedCostMethod" NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "capitalized_amount" DECIMAL(19,4) NOT NULL,
    "expensed_amount" DECIMAL(19,4) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "posted_by_user_id" UUID NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "landed_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landed_cost_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "landed_cost_id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "allocated_amount" DECIMAL(19,4) NOT NULL,
    "received_quantity_base" DECIMAL(20,6) NOT NULL,
    "on_hand_quantity" DECIMAL(20,6) NOT NULL,
    "capitalized_amount" DECIMAL(19,4) NOT NULL,
    "expensed_amount" DECIMAL(19,4) NOT NULL,
    "previous_value" DECIMAL(19,4) NOT NULL,
    "new_value" DECIMAL(19,4) NOT NULL,
    "previous_unit_cost" DECIMAL(20,6),
    "new_unit_cost" DECIMAL(20,6),

    CONSTRAINT "landed_cost_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "landed_costs_organization_id_receipt_id_idx" ON "landed_costs"("organization_id", "receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "landed_costs_organization_id_id_key" ON "landed_costs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "landed_costs_organization_id_document_id_key" ON "landed_costs"("organization_id", "document_id");

-- CreateIndex
CREATE INDEX "landed_cost_lines_organization_id_warehouse_id_product_id_idx" ON "landed_cost_lines"("organization_id", "warehouse_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "landed_cost_lines_organization_id_id_key" ON "landed_cost_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "landed_cost_lines_organization_id_landed_cost_id_receipt_li_key" ON "landed_cost_lines"("organization_id", "landed_cost_id", "receipt_line_id");

-- AddForeignKey
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_organization_id_receipt_id_fkey" FOREIGN KEY ("organization_id", "receipt_id") REFERENCES "goods_receipts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_organization_id_landed_cost_id_fkey" FOREIGN KEY ("organization_id", "landed_cost_id") REFERENCES "landed_costs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_organization_id_receipt_line_id_fkey" FOREIGN KEY ("organization_id", "receipt_line_id") REFERENCES "goods_receipt_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-028) ───

ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_amounts_ck"
  CHECK ("amount" > 0 AND "capitalized_amount" >= 0 AND "expensed_amount" >= 0
         AND "capitalized_amount" + "expensed_amount" = "amount");
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_amounts_ck"
  CHECK ("allocated_amount" >= 0 AND "capitalized_amount" >= 0 AND "expensed_amount" >= 0
         AND "capitalized_amount" + "expensed_amount" = "allocated_amount"
         AND "received_quantity_base" > 0 AND "on_hand_quantity" >= 0
         AND "previous_value" >= 0 AND "new_value" = "previous_value" + "capitalized_amount");

-- Append-only, like the ledger and revaluations.
CREATE TRIGGER "landed_costs_append_only"
  BEFORE UPDATE OR DELETE ON "landed_costs"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "landed_costs_no_truncate"
  BEFORE TRUNCATE ON "landed_costs"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "landed_cost_lines_append_only"
  BEFORE UPDATE OR DELETE ON "landed_cost_lines"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "landed_cost_lines_no_truncate"
  BEFORE TRUNCATE ON "landed_cost_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_modification"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT ON "landed_costs", "landed_cost_lines" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['landed_costs', 'landed_cost_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
