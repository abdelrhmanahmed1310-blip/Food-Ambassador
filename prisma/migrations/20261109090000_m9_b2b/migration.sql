-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "SalesInvoiceStatus" AS ENUM ('POSTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "InventoryDocumentType" ADD VALUE 'CUSTOMER_DELIVERY';

-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'CUSTOMER_DELIVERY';

-- DropIndex
DROP INDEX "purchase_requisition_lines_shipment_idx";

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "tax_id" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "payment_terms_days" INTEGER,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "customer_ref" TEXT,
    "requested_on" DATE,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "uom_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "quantity_base" DECIMAL(20,6) NOT NULL,
    "unit_price" DECIMAL(20,6) NOT NULL,
    "tax_code_id" UUID,
    "delivered_quantity_base" DECIMAL(20,6) NOT NULL DEFAULT 0,

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'POSTED',
    "document_id" UUID NOT NULL,
    "reversal_document_id" UUID,
    "cost" DECIMAL(19,4) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_by_user_id" UUID NOT NULL,
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" TEXT,

    CONSTRAINT "customer_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_delivery_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity_base" DECIMAL(20,6) NOT NULL,
    "cost" DECIMAL(19,4) NOT NULL,

    CONSTRAINT "customer_delivery_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE,
    "status" "SalesInvoiceStatus" NOT NULL DEFAULT 'POSTED',
    "net_amount" DECIMAL(19,4) NOT NULL,
    "tax_amount" DECIMAL(19,4) NOT NULL,
    "gross_amount" DECIMAL(19,4) NOT NULL,
    "cost" DECIMAL(19,4) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit_price" DECIMAL(20,6) NOT NULL,
    "tax_code_id" UUID,
    "tax_rate" DECIMAL(9,6),
    "net_amount" DECIMAL(19,4) NOT NULL,
    "tax_amount" DECIMAL(19,4) NOT NULL,
    "gross_amount" DECIMAL(19,4) NOT NULL,

    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_receipts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'POSTED',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "void_reason" TEXT,

    CONSTRAINT "customer_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_receipt_allocations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_receipt_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_code_key" ON "customers"("organization_id", "code");

-- CreateIndex
CREATE INDEX "sales_orders_organization_id_customer_id_status_idx" ON "sales_orders"("organization_id", "customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_organization_id_id_key" ON "sales_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_organization_id_number_key" ON "sales_orders"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_lines_organization_id_id_key" ON "sales_order_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_lines_organization_id_order_id_line_no_key" ON "sales_order_lines"("organization_id", "order_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "customer_deliveries_organization_id_id_key" ON "customer_deliveries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_deliveries_organization_id_number_key" ON "customer_deliveries"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "customer_deliveries_organization_id_document_id_key" ON "customer_deliveries"("organization_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_deliveries_organization_id_reversal_document_id_key" ON "customer_deliveries"("organization_id", "reversal_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_delivery_lines_organization_id_delivery_id_order_l_key" ON "customer_delivery_lines"("organization_id", "delivery_id", "order_line_id");

-- CreateIndex
CREATE INDEX "sales_invoices_organization_id_customer_id_invoice_date_idx" ON "sales_invoices"("organization_id", "customer_id", "invoice_date");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_organization_id_id_key" ON "sales_invoices"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_organization_id_number_key" ON "sales_invoices"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoice_lines_organization_id_invoice_id_line_no_key" ON "sales_invoice_lines"("organization_id", "invoice_id", "line_no");

-- CreateIndex
CREATE INDEX "customer_receipts_organization_id_customer_id_date_idx" ON "customer_receipts"("organization_id", "customer_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "customer_receipts_organization_id_id_key" ON "customer_receipts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_receipts_organization_id_number_key" ON "customer_receipts"("organization_id", "number");

-- CreateIndex
CREATE INDEX "customer_receipt_allocations_organization_id_invoice_id_idx" ON "customer_receipt_allocations"("organization_id", "invoice_id");

-- CreateIndex
CREATE INDEX "customer_receipt_allocations_organization_id_receipt_id_idx" ON "customer_receipt_allocations"("organization_id", "receipt_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organization_id_order_id_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "sales_orders"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_deliveries" ADD CONSTRAINT "customer_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_deliveries" ADD CONSTRAINT "customer_deliveries_organization_id_order_id_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "sales_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_deliveries" ADD CONSTRAINT "customer_deliveries_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_deliveries" ADD CONSTRAINT "customer_deliveries_organization_id_reversal_document_id_fkey" FOREIGN KEY ("organization_id", "reversal_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_delivery_lines" ADD CONSTRAINT "customer_delivery_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_delivery_lines" ADD CONSTRAINT "customer_delivery_lines_organization_id_delivery_id_fkey" FOREIGN KEY ("organization_id", "delivery_id") REFERENCES "customer_deliveries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_delivery_lines" ADD CONSTRAINT "customer_delivery_lines_organization_id_order_line_id_fkey" FOREIGN KEY ("organization_id", "order_line_id") REFERENCES "sales_order_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organization_id_delivery_id_fkey" FOREIGN KEY ("organization_id", "delivery_id") REFERENCES "customer_deliveries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "sales_invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_organization_id_receipt_id_fkey" FOREIGN KEY ("organization_id", "receipt_id") REFERENCES "customer_receipts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "sales_invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-047) ───

ALTER TABLE "customers" ADD CONSTRAINT "customers_values_ck"
  CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' AND ("payment_terms_days" IS NULL OR "payment_terms_days" BETWEEN 0 AND 365));
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_status_ck"
  CHECK ((("status" = 'DRAFT') = ("confirmed_at" IS NULL OR "status" = 'CANCELLED'))
     AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)));
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_values_ck"
  CHECK ("line_no" > 0 AND "quantity" > 0 AND "quantity_base" > 0 AND "unit_price" >= 0
     AND "delivered_quantity_base" >= 0 AND "delivered_quantity_base" <= "quantity_base");
ALTER TABLE "customer_deliveries" ADD CONSTRAINT "customer_deliveries_status_ck"
  CHECK ("cost" >= 0 AND (("status" = 'REVERSED') = ("reversal_document_id" IS NOT NULL AND "reversed_at" IS NOT NULL)));
ALTER TABLE "customer_delivery_lines" ADD CONSTRAINT "customer_delivery_lines_values_ck"
  CHECK ("quantity_base" > 0 AND "cost" >= 0);
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_values_ck"
  CHECK ("gross_amount" = "net_amount" + "tax_amount" AND "net_amount" >= 0 AND "tax_amount" >= 0
     AND ("due_date" IS NULL OR "due_date" >= "invoice_date")
     AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)));
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_values_ck"
  CHECK ("line_no" > 0 AND "quantity" > 0 AND "unit_price" >= 0 AND "gross_amount" = "net_amount" + "tax_amount");
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_values_ck"
  CHECK ("amount" > 0 AND (("status" = 'VOIDED') = ("voided_at" IS NOT NULL)));
ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_amount_ck" CHECK ("amount" > 0);

-- One invoice per delivery while it is not cancelled.
CREATE UNIQUE INDEX "sales_invoices_one_per_delivery" ON "sales_invoices" ("organization_id", "delivery_id")
  WHERE "status" <> 'CANCELLED';

-- Invoices, their lines and receipts are fixed once posted: only cancelling / voiding changes them.
CREATE FUNCTION "b2b_fixed_except"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE free text[] := TG_ARGV::text[];
BEGIN
  IF (to_jsonb(NEW) - free) <> (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION '% rows can only be cancelled or voided', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "sales_invoices_fixed" BEFORE UPDATE ON "sales_invoices"
  FOR EACH ROW EXECUTE FUNCTION "b2b_fixed_except"('status', 'cancelled_at', 'cancelled_by_user_id', 'cancel_reason');
CREATE TRIGGER "customer_receipts_fixed" BEFORE UPDATE ON "customer_receipts"
  FOR EACH ROW EXECUTE FUNCTION "b2b_fixed_except"('status', 'voided_at', 'voided_by_user_id', 'void_reason');

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "customers", "sales_orders", "customer_deliveries", "sales_invoices", "customer_receipts" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sales_order_lines" TO fa_tenant;
GRANT SELECT, INSERT ON "customer_delivery_lines", "sales_invoice_lines", "customer_receipt_allocations" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'sales_orders', 'sales_order_lines', 'customer_deliveries', 'customer_delivery_lines',
                           'sales_invoices', 'sales_invoice_lines', 'customer_receipts', 'customer_receipt_allocations']
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
  ('admin', 'b2b.view'), ('admin', 'b2b.manage'),
  ('operations_manager', 'b2b.view'), ('operations_manager', 'b2b.manage'),
  ('finance', 'b2b.view'), ('finance', 'b2b.manage'),
  ('analyst', 'b2b.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
