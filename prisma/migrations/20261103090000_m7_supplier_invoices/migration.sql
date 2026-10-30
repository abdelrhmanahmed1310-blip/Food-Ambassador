-- CreateEnum
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceMatchStatus" AS ENUM ('MATCHED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('GOODS', 'CHARGE');

-- CreateEnum
CREATE TYPE "InvoiceLineMatch" AS ENUM ('MATCHED', 'PRICE_VARIANCE', 'QUANTITY_VARIANCE', 'PRICE_AND_QUANTITY', 'NOT_APPLICABLE');

-- AlterTable
ALTER TABLE "procurement_settings" ADD COLUMN     "invoice_price_tolerance" DECIMAL(9,6) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "supplier_invoices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_invoice_no" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE,
    "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "printed_gross" DECIMAL(19,4) NOT NULL,
    "net_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "gross_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "match_status" "InvoiceMatchStatus" NOT NULL DEFAULT 'MATCHED',
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exception_approved_at" TIMESTAMPTZ(3),
    "exception_approved_by_id" UUID,
    "exception_note" TEXT,
    "posted_at" TIMESTAMPTZ(3),
    "posted_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "cancel_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL,
    "receipt_line_id" UUID,
    "purchase_order_line_id" UUID,
    "product_id" UUID,
    "description" TEXT NOT NULL,
    "uom_id" UUID,
    "quantity" DECIMAL(20,6) NOT NULL,
    "quantity_base" DECIMAL(20,6),
    "unit_price" DECIMAL(20,6) NOT NULL,
    "ordered_unit_price" DECIMAL(20,6),
    "received_unit_price" DECIMAL(20,6),
    "tax_code_id" UUID,
    "tax_rate" DECIMAL(7,6),
    "net_amount" DECIMAL(19,4) NOT NULL,
    "tax_amount" DECIMAL(19,4) NOT NULL,
    "gross_amount" DECIMAL(19,4) NOT NULL,
    "match" "InvoiceLineMatch" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "quantity_variance" DECIMAL(20,6),
    "price_variance" DECIMAL(19,4),

    CONSTRAINT "supplier_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_invoices_organization_id_supplier_id_invoice_date_idx" ON "supplier_invoices"("organization_id", "supplier_id", "invoice_date");

-- CreateIndex
CREATE INDEX "supplier_invoices_organization_id_status_idx" ON "supplier_invoices"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_organization_id_id_key" ON "supplier_invoices"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_organization_id_number_key" ON "supplier_invoices"("organization_id", "number");

-- CreateIndex
CREATE INDEX "supplier_invoice_lines_organization_id_receipt_line_id_idx" ON "supplier_invoice_lines"("organization_id", "receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_lines_organization_id_id_key" ON "supplier_invoice_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_lines_organization_id_invoice_id_line_no_key" ON "supplier_invoice_lines"("organization_id", "invoice_id", "line_no");

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "supplier_invoices"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_organization_id_receipt_line_id_fkey" FOREIGN KEY ("organization_id", "receipt_line_id") REFERENCES "goods_receipt_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_organization_id_purchase_order_line_fkey" FOREIGN KEY ("organization_id", "purchase_order_line_id") REFERENCES "purchase_order_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-038) ───

ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_invoice_tolerance_ck"
  CHECK ("invoice_price_tolerance" >= 0 AND "invoice_price_tolerance" <= 1);
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_status_ck"
  CHECK ((("status" = 'POSTED') = ("posted_at" IS NOT NULL))
     AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL))
     AND ("exception_approved_by_id" IS NULL OR "exception_approved_by_id" <> "created_by_user_id")
     AND ("due_date" IS NULL OR "due_date" >= "invoice_date"));
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_values_ck"
  CHECK ("line_no" > 0 AND "quantity" > 0 AND "unit_price" >= 0
     AND "gross_amount" = "net_amount" + "tax_amount"
     AND (("kind" = 'GOODS') = ("receipt_line_id" IS NOT NULL))
     AND ("kind" = 'CHARGE' OR ("product_id" IS NOT NULL AND "uom_id" IS NOT NULL AND "quantity_base" > 0)));

-- A supplier's invoice number is entered once (cancelled invoices aside).
CREATE UNIQUE INDEX "supplier_invoices_supplier_number" ON "supplier_invoices" ("organization_id", "supplier_id", "supplier_invoice_no")
  WHERE "status" <> 'CANCELLED';

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "supplier_invoices" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_invoice_lines" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_invoices', 'supplier_invoice_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- Lines of a posted or cancelled invoice are fixed.
CREATE FUNCTION "supplier_invoice_line_draft_only"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "SupplierInvoiceStatus";
BEGIN
  SELECT "status" INTO s FROM "supplier_invoices"
  WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."invoice_id" ELSE NEW."invoice_id" END;
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'lines of a % invoice cannot be changed', s USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER "supplier_invoice_lines_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "supplier_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "supplier_invoice_line_draft_only"();

-- ─── New permissions for existing organizations' system roles ───
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'invoices.view'), ('admin', 'invoices.manage'),
  ('operations_manager', 'invoices.view'), ('operations_manager', 'invoices.manage'),
  ('finance', 'invoices.view'), ('finance', 'invoices.manage'),
  ('procurement', 'invoices.view'), ('analyst', 'invoices.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
