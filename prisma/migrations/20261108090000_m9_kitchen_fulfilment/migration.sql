-- AlterTable
ALTER TABLE "purchase_requisition_lines" ADD COLUMN     "shipment_id" UUID;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_shipment_id_fkey" FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "stock_shipments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A requisition line is met either by a purchase order line or by a shipment from own stock (ADR-046).
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_one_source_ck"
  CHECK ("purchase_order_line_id" IS NULL OR "shipment_id" IS NULL);
CREATE INDEX "purchase_requisition_lines_shipment_idx" ON "purchase_requisition_lines" ("organization_id", "shipment_id");
