-- M3c-2: in-transit shipments between warehouses (DECISIONS.md ADR-026).

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryDocumentType" ADD VALUE 'DISPATCH';
ALTER TYPE "InventoryDocumentType" ADD VALUE 'TRANSIT_RECEIPT';

-- AlterEnum
ALTER TYPE "StockStatus" ADD VALUE 'IN_TRANSIT';

-- CreateTable
CREATE TABLE "stock_shipments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "from_warehouse_id" UUID NOT NULL,
    "to_warehouse_id" UUID NOT NULL,
    "to_location_id" UUID,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "expected_on" DATE,
    "note" TEXT,
    "dispatch_document_id" UUID,
    "receipt_document_id" UUID,
    "cancel_document_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "dispatched_at" TIMESTAMPTZ(3),
    "dispatched_by_user_id" UUID,
    "received_at" TIMESTAMPTZ(3),
    "received_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_shipment_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID,
    "from_warehouse_id" UUID NOT NULL,
    "from_location_id" UUID,
    "uom_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "quantity_base" DECIMAL(20,6) NOT NULL,
    "received_quantity_base" DECIMAL(20,6),
    "shortage_reason" TEXT,

    CONSTRAINT "stock_shipment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_shipments_organization_id_status_idx" ON "stock_shipments"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_shipments_organization_id_id_key" ON "stock_shipments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_shipments_organization_id_number_key" ON "stock_shipments"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_shipments_organization_id_dispatch_document_id_key" ON "stock_shipments"("organization_id", "dispatch_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_shipments_organization_id_receipt_document_id_key" ON "stock_shipments"("organization_id", "receipt_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_shipments_organization_id_cancel_document_id_key" ON "stock_shipments"("organization_id", "cancel_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_shipment_lines_organization_id_id_key" ON "stock_shipment_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_shipment_lines_organization_id_shipment_id_line_no_key" ON "stock_shipment_lines"("organization_id", "shipment_id", "line_no");

-- AddForeignKey
ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_organization_id_from_warehouse_id_fkey" FOREIGN KEY ("organization_id", "from_warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_organization_id_to_warehouse_id_fkey" FOREIGN KEY ("organization_id", "to_warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_organization_id_to_warehouse_id_to_locatio_fkey" FOREIGN KEY ("organization_id", "to_warehouse_id", "to_location_id") REFERENCES "storage_locations"("organization_id", "warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_organization_id_dispatch_document_id_fkey" FOREIGN KEY ("organization_id", "dispatch_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_organization_id_receipt_document_id_fkey" FOREIGN KEY ("organization_id", "receipt_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_organization_id_cancel_document_id_fkey" FOREIGN KEY ("organization_id", "cancel_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipment_lines" ADD CONSTRAINT "stock_shipment_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipment_lines" ADD CONSTRAINT "stock_shipment_lines_organization_id_shipment_id_fkey" FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "stock_shipments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipment_lines" ADD CONSTRAINT "stock_shipment_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipment_lines" ADD CONSTRAINT "stock_shipment_lines_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipment_lines" ADD CONSTRAINT "stock_shipment_lines_organization_id_from_warehouse_id_fro_fkey" FOREIGN KEY ("organization_id", "from_warehouse_id", "from_location_id") REFERENCES "storage_locations"("organization_id", "warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_shipment_lines" ADD CONSTRAINT "stock_shipment_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Constraints ───

ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_route_ck"
  CHECK ("from_warehouse_id" <> "to_warehouse_id");
-- Each status carries exactly the documents and timestamps it implies.
ALTER TABLE "stock_shipments" ADD CONSTRAINT "stock_shipments_state_ck"
  CHECK (("status" = 'DRAFT' AND "dispatch_document_id" IS NULL AND "receipt_document_id" IS NULL)
      OR ("status" = 'IN_TRANSIT' AND "dispatch_document_id" IS NOT NULL AND "receipt_document_id" IS NULL
          AND "dispatched_at" IS NOT NULL)
      OR ("status" = 'RECEIVED' AND "dispatch_document_id" IS NOT NULL AND "receipt_document_id" IS NOT NULL
          AND "received_at" IS NOT NULL)
      OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "receipt_document_id" IS NULL));
ALTER TABLE "stock_shipment_lines" ADD CONSTRAINT "stock_shipment_lines_quantities_ck"
  CHECK ("quantity" > 0 AND "quantity_base" > 0 AND "line_no" > 0
         AND ("received_quantity_base" IS NULL
              OR ("received_quantity_base" >= 0 AND "received_quantity_base" <= "quantity_base"))
         AND ("received_quantity_base" IS NULL OR "received_quantity_base" = "quantity_base"
              OR "shortage_reason" IS NOT NULL));

CREATE TRIGGER "stock_shipment_lines_unit_visible" BEFORE INSERT OR UPDATE ON "stock_shipment_lines"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('uom_id');

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_shipments", "stock_shipment_lines" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_shipments', 'stock_shipment_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
