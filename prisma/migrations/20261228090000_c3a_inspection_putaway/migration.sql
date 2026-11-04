-- CreateEnum
CREATE TYPE "LocationZone" AS ENUM ('RECEIVING', 'QUARANTINE', 'STORAGE', 'PICKING', 'DISPATCH');

-- CreateEnum
CREATE TYPE "InspectionDecision" AS ENUM ('ACCEPTED', 'REJECTED', 'PARTIAL');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "inspect_on_receipt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "storage_locations" ADD COLUMN     "zone" "LocationZone" NOT NULL DEFAULT 'STORAGE';

-- CreateTable
CREATE TABLE "receipt_inspections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "accepted_quantity" DECIMAL(20,6) NOT NULL,
    "rejected_quantity" DECIMAL(20,6) NOT NULL,
    "decision" "InspectionDecision" NOT NULL,
    "temperature_celsius" DECIMAL(5,1),
    "packaging_ok" BOOLEAN NOT NULL,
    "labelling_ok" BOOLEAN NOT NULL,
    "condition_ok" BOOLEAN NOT NULL,
    "rejection_reason" TEXT,
    "note" TEXT,
    "inventory_document_id" UUID NOT NULL,
    "inspected_by_user_id" UUID NOT NULL,
    "inspected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "putaway_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL,
    "product_id" UUID,
    "category_id" UUID,
    "storage_requirement" "TemperatureZone",
    "location_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "putaway_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipt_inspections_organization_id_warehouse_id_inspected__idx" ON "receipt_inspections"("organization_id", "warehouse_id", "inspected_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "receipt_inspections_organization_id_id_key" ON "receipt_inspections"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_inspections_organization_id_receipt_line_id_key" ON "receipt_inspections"("organization_id", "receipt_line_id");

-- CreateIndex
CREATE INDEX "putaway_rules_organization_id_warehouse_id_priority_idx" ON "putaway_rules"("organization_id", "warehouse_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "putaway_rules_organization_id_id_key" ON "putaway_rules"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "receipt_inspections" ADD CONSTRAINT "receipt_inspections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_inspections" ADD CONSTRAINT "receipt_inspections_organization_id_receipt_line_id_fkey" FOREIGN KEY ("organization_id", "receipt_line_id") REFERENCES "goods_receipt_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_inspections" ADD CONSTRAINT "receipt_inspections_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_inspections" ADD CONSTRAINT "receipt_inspections_organization_id_inventory_document_id_fkey" FOREIGN KEY ("organization_id", "inventory_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_rules" ADD CONSTRAINT "putaway_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_rules" ADD CONSTRAINT "putaway_rules_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_rules" ADD CONSTRAINT "putaway_rules_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_rules" ADD CONSTRAINT "putaway_rules_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "product_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_rules" ADD CONSTRAINT "putaway_rules_organization_id_warehouse_id_location_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id", "location_id") REFERENCES "storage_locations"("organization_id", "warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C3a receiving inspection and put-away (ADR-101): hand-written rules ───
ALTER TABLE "receipt_inspections" ADD CONSTRAINT "receipt_inspections_ck" CHECK (
  "accepted_quantity" >= 0 AND "rejected_quantity" >= 0
  AND "accepted_quantity" + "rejected_quantity" > 0
  AND ("decision" <> 'ACCEPTED' OR "rejected_quantity" = 0)
  AND ("decision" <> 'REJECTED' OR "accepted_quantity" = 0)
  AND ("decision" <> 'PARTIAL' OR ("accepted_quantity" > 0 AND "rejected_quantity" > 0))
  AND ("rejected_quantity" = 0 OR length(btrim(coalesce("rejection_reason", ''))) > 0));
ALTER TABLE "putaway_rules" ADD CONSTRAINT "putaway_rules_ck" CHECK (
  "priority" BETWEEN 1 AND 9999);

-- Inspections are evidence: never changed or deleted.
GRANT SELECT, INSERT ON "receipt_inspections" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "putaway_rules" TO fa_tenant;
ALTER TABLE "receipt_inspections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "receipt_inspections" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "putaway_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "putaway_rules" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

CREATE OR REPLACE FUNCTION receipt_inspection_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'receipt inspections are evidence and cannot change';
END $$;
CREATE TRIGGER "receipt_inspections_immutable" BEFORE UPDATE OR DELETE ON "receipt_inspections"
  FOR EACH ROW EXECUTE FUNCTION receipt_inspection_immutable();
