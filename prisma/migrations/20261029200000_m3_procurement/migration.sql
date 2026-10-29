-- M3b: suppliers, purchase orders and receiving (DECISIONS.md ADR-023).

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('POSTED', 'REVERSED');

-- AlterEnum
ALTER TYPE "InventoryDocumentType" ADD VALUE 'RECEIPT';

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "tax_id" TEXT,
    "contact_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "payment_terms_days" INTEGER,
    "lead_time_days" INTEGER,
    "note" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "supplier_sku" TEXT,
    "purchase_uom_id" UUID NOT NULL,
    "last_unit_price" DECIMAL(20,6),
    "last_price_at" TIMESTAMPTZ(3),
    "lead_time_days" INTEGER,
    "min_order_quantity" DECIMAL(20,6),
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_settings" (
    "organization_id" UUID NOT NULL,
    "approval_threshold" DECIMAL(19,4),
    "over_receipt_tolerance" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "procurement_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "expected_on" DATE,
    "note" TEXT,
    "total_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "approved_by_user_id" UUID,
    "auto_approved" BOOLEAN NOT NULL DEFAULT false,
    "rejection_note" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_user_id" UUID,
    "close_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "uom_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "quantity_base" DECIMAL(20,6) NOT NULL,
    "unit_price" DECIMAL(20,6) NOT NULL,
    "line_total" DECIMAL(19,4) NOT NULL,
    "received_quantity_base" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'POSTED',
    "inventory_document_id" UUID,
    "reversal_document_id" UUID,
    "delivery_note_ref" TEXT,
    "note" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "posted_by_user_id" UUID NOT NULL,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_user_id" UUID,
    "reversal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "purchase_order_line_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "uom_id" UUID NOT NULL,
    "received_quantity" DECIMAL(20,6) NOT NULL,
    "accepted_quantity" DECIMAL(20,6) NOT NULL,
    "rejected_quantity" DECIMAL(20,6) NOT NULL,
    "accepted_quantity_base" DECIMAL(20,6) NOT NULL,
    "rejected_quantity_base" DECIMAL(20,6) NOT NULL,
    "rejection_reason" TEXT,
    "quarantine" BOOLEAN NOT NULL DEFAULT false,
    "lot_id" UUID,
    "unit_price" DECIMAL(20,6) NOT NULL,
    "ordered_unit_price" DECIMAL(20,6) NOT NULL,
    "temperature_celsius" DECIMAL(5,1),

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_organization_id_id_key" ON "suppliers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_organization_id_code_key" ON "suppliers"("organization_id", "code");

-- CreateIndex
CREATE INDEX "supplier_products_organization_id_product_id_idx" ON "supplier_products"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_organization_id_id_key" ON "supplier_products"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_organization_id_supplier_id_product_id_key" ON "supplier_products"("organization_id", "supplier_id", "product_id");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_status_idx" ON "purchase_orders"("organization_id", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_supplier_id_idx" ON "purchase_orders"("organization_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_id_key" ON "purchase_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_number_key" ON "purchase_orders"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_organization_id_id_key" ON "purchase_order_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_organization_id_purchase_order_id_line_key" ON "purchase_order_lines"("organization_id", "purchase_order_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_organization_id_purchase_order_id_prod_key" ON "purchase_order_lines"("organization_id", "purchase_order_id", "product_id");

-- CreateIndex
CREATE INDEX "goods_receipts_organization_id_purchase_order_id_idx" ON "goods_receipts"("organization_id", "purchase_order_id");

-- CreateIndex
CREATE INDEX "goods_receipts_organization_id_supplier_id_received_at_idx" ON "goods_receipts"("organization_id", "supplier_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_organization_id_id_key" ON "goods_receipts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_organization_id_number_key" ON "goods_receipts"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_organization_id_inventory_document_id_key" ON "goods_receipts"("organization_id", "inventory_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_organization_id_reversal_document_id_key" ON "goods_receipts"("organization_id", "reversal_document_id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_organization_id_receipt_id_idx" ON "goods_receipt_lines"("organization_id", "receipt_id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_organization_id_purchase_order_line_id_idx" ON "goods_receipt_lines"("organization_id", "purchase_order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_organization_id_id_key" ON "goods_receipt_lines"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_purchase_uom_id_fkey" FOREIGN KEY ("purchase_uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_warehouse_id_location_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id", "location_id") REFERENCES "storage_locations"("organization_id", "warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_inventory_document_id_fkey" FOREIGN KEY ("organization_id", "inventory_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_reversal_document_id_fkey" FOREIGN KEY ("organization_id", "reversal_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_receipt_id_fkey" FOREIGN KEY ("organization_id", "receipt_id") REFERENCES "goods_receipts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_purchase_order_line_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_line_id") REFERENCES "purchase_order_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Constraints ───

ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_days_ck"
  CHECK (("payment_terms_days" IS NULL OR "payment_terms_days" BETWEEN 0 AND 3650)
     AND ("lead_time_days" IS NULL OR "lead_time_days" BETWEEN 0 AND 3650));
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_amounts_ck"
  CHECK (("last_unit_price" IS NULL OR "last_unit_price" >= 0)
     AND ("lead_time_days" IS NULL OR "lead_time_days" BETWEEN 0 AND 3650)
     AND ("min_order_quantity" IS NULL OR "min_order_quantity" > 0));
ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_values_ck"
  CHECK (("approval_threshold" IS NULL OR "approval_threshold" >= 0)
     AND "over_receipt_tolerance" BETWEEN 0 AND 1);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_total_ck" CHECK ("total_amount" >= 0);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approval_ck"
  CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')
         OR ("approved_at" IS NOT NULL AND "approved_by_user_id" IS NOT NULL));
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_amounts_ck"
  CHECK ("quantity" > 0 AND "quantity_base" > 0 AND "unit_price" >= 0 AND "line_total" >= 0
         AND "received_quantity_base" >= 0 AND "line_no" > 0);
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_reversal_ck"
  CHECK (("status" = 'REVERSED') = ("reversed_at" IS NOT NULL));
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_quantities_ck"
  CHECK ("received_quantity" > 0 AND "accepted_quantity" >= 0 AND "rejected_quantity" >= 0
         AND "accepted_quantity" + "rejected_quantity" = "received_quantity"
         AND "accepted_quantity_base" >= 0 AND "rejected_quantity_base" >= 0
         AND "unit_price" >= 0 AND "ordered_unit_price" >= 0
         AND ("rejected_quantity" = 0 OR "rejection_reason" IS NOT NULL));

-- Receipt lines are history; only the receipt header changes (on reversal).
CREATE TRIGGER "goods_receipt_lines_append_only"
  BEFORE UPDATE OR DELETE ON "goods_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();

-- Unit references: system unit or the row's own tenant (see M2).
CREATE TRIGGER "supplier_products_unit_visible" BEFORE INSERT OR UPDATE ON "supplier_products"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('purchase_uom_id');
CREATE TRIGGER "purchase_order_lines_unit_visible" BEFORE INSERT OR UPDATE ON "purchase_order_lines"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('uom_id');
CREATE TRIGGER "goods_receipt_lines_unit_visible" BEFORE INSERT ON "goods_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('uom_id');

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "suppliers", "supplier_products", "procurement_settings", "goods_receipts" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_orders", "purchase_order_lines" TO fa_tenant;
GRANT SELECT, INSERT ON "goods_receipt_lines" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers', 'supplier_products', 'procurement_settings', 'purchase_orders',
    'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- ─── New permissions for existing organizations' system roles ───
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'suppliers.view'), ('admin', 'suppliers.manage'), ('admin', 'purchasing.view'),
  ('admin', 'purchasing.manage'), ('admin', 'purchasing.approve'), ('admin', 'purchasing.receive'),
  ('operations_manager', 'suppliers.view'), ('operations_manager', 'purchasing.view'),
  ('operations_manager', 'purchasing.approve'), ('operations_manager', 'purchasing.receive'),
  ('procurement', 'suppliers.view'), ('procurement', 'suppliers.manage'), ('procurement', 'purchasing.view'),
  ('procurement', 'purchasing.manage'), ('procurement', 'purchasing.receive'),
  ('warehouse', 'suppliers.view'), ('warehouse', 'purchasing.view'), ('warehouse', 'purchasing.receive'),
  ('food_safety', 'suppliers.view'), ('food_safety', 'purchasing.view'),
  ('finance', 'suppliers.view'), ('finance', 'purchasing.view'), ('finance', 'purchasing.approve'),
  ('branch_manager', 'suppliers.view'), ('branch_manager', 'purchasing.view'),
  ('branch_manager', 'purchasing.manage'), ('branch_manager', 'purchasing.receive'),
  ('analyst', 'suppliers.view'), ('analyst', 'purchasing.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
