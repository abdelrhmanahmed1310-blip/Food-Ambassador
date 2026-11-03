-- CreateEnum
CREATE TYPE "SupplierReturnStatus" AS ENUM ('DRAFT', 'POSTED', 'CREDITED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierReturnReason" AS ENUM ('QUALITY', 'DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'RECALL', 'OVERSUPPLY', 'OTHER');

-- AlterEnum
ALTER TYPE "InventoryDocumentType" ADD VALUE 'SUPPLIER_RETURN';

-- CreateTable
CREATE TABLE "supplier_returns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "SupplierReturnStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" "SupplierReturnReason" NOT NULL,
    "note" TEXT,
    "total_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "inventory_document_id" UUID,
    "reversal_document_id" UUID,
    "credit_note_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMPTZ(3),
    "posted_by_user_id" UUID,
    "credited_at" TIMESTAMPTZ(3),
    "credited_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "decision_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_return_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID,
    "uom_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "quantity_base" DECIMAL(20,6) NOT NULL,
    "unit_price" DECIMAL(20,6) NOT NULL,
    "line_total" DECIMAL(19,4) NOT NULL,
    "from_status" "StockStatus" NOT NULL,

    CONSTRAINT "supplier_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_returns_organization_id_status_idx" ON "supplier_returns"("organization_id", "status");

-- CreateIndex
CREATE INDEX "supplier_returns_organization_id_supplier_id_idx" ON "supplier_returns"("organization_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_returns_organization_id_id_key" ON "supplier_returns"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_returns_organization_id_number_key" ON "supplier_returns"("organization_id", "number");

-- CreateIndex
CREATE INDEX "supplier_return_lines_organization_id_receipt_line_id_idx" ON "supplier_return_lines"("organization_id", "receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_return_lines_organization_id_id_key" ON "supplier_return_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_return_lines_organization_id_return_id_line_no_key" ON "supplier_return_lines"("organization_id", "return_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_return_lines_organization_id_return_id_receipt_lin_key" ON "supplier_return_lines"("organization_id", "return_id", "receipt_line_id");

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_organization_id_inventory_document_id_fkey" FOREIGN KEY ("organization_id", "inventory_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_organization_id_reversal_document_id_fkey" FOREIGN KEY ("organization_id", "reversal_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_organization_id_credit_note_id_fkey" FOREIGN KEY ("organization_id", "credit_note_id") REFERENCES "supplier_settlements"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_organization_id_return_id_fkey" FOREIGN KEY ("organization_id", "return_id") REFERENCES "supplier_returns"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_organization_id_receipt_line_id_fkey" FOREIGN KEY ("organization_id", "receipt_line_id") REFERENCES "goods_receipt_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ─── C1d supplier returns (ADR-094): hand-written rules ───

ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_lot_fkey"
  FOREIGN KEY ("organization_id", "product_id", "lot_id")
  REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT;
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_amounts"
  CHECK ("quantity" > 0 AND "quantity_base" > 0 AND "unit_price" >= 0 AND "line_total" >= 0
     AND "from_status" IN ('AVAILABLE', 'QUARANTINE'));
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_total" CHECK ("total_amount" >= 0);
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_state" CHECK (
  ("status" IN ('POSTED', 'CREDITED', 'REVERSED'))
    = ("inventory_document_id" IS NOT NULL AND "posted_at" IS NOT NULL AND "posted_by_user_id" IS NOT NULL)
  AND ("status" = 'CREDITED')
    = ("credit_note_id" IS NOT NULL AND "credited_at" IS NOT NULL AND "credited_by_user_id" IS NOT NULL)
  AND ("status" = 'REVERSED') = ("reversal_document_id" IS NOT NULL)
  AND ("status" IN ('CANCELLED', 'REVERSED'))
    = ("decided_at" IS NOT NULL AND "decided_by_user_id" IS NOT NULL
       AND length(btrim(coalesce("decision_reason", ''))) > 0));

-- A line is part of a receipt from this supplier, at this warehouse, in this
-- currency, and carries that receipt line's product, lot and unit. Lines
-- change only while the return is a draft.
CREATE FUNCTION supplier_return_line_matches() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT "status" INTO r FROM "supplier_returns"
      WHERE "organization_id" = OLD."organization_id" AND "id" = OLD."return_id";
    IF r."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'lines of a posted supplier return cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  SELECT sr."status", sr."supplier_id", sr."warehouse_id", sr."currency",
         gl."product_id", gl."lot_id", gl."uom_id",
         g."supplier_id" AS g_supplier, g."warehouse_id" AS g_warehouse, g."currency" AS g_currency,
         g."status" AS g_status
    INTO r
    FROM "supplier_returns" sr, "goods_receipt_lines" gl
    JOIN "goods_receipts" g ON g."organization_id" = gl."organization_id" AND g."id" = gl."receipt_id"
   WHERE sr."organization_id" = NEW."organization_id" AND sr."id" = NEW."return_id"
     AND gl."organization_id" = NEW."organization_id" AND gl."id" = NEW."receipt_line_id";
  IF r."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'lines of a posted supplier return cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF r.g_status <> 'POSTED' OR r.g_supplier <> r."supplier_id" OR r.g_warehouse <> r."warehouse_id"
     OR r.g_currency <> r."currency" OR r."product_id" <> NEW."product_id"
     OR r."lot_id" IS DISTINCT FROM NEW."lot_id" OR r."uom_id" <> NEW."uom_id" THEN
    RAISE EXCEPTION 'a return line must match a posted receipt line of the same supplier, warehouse and currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_return_lines_match" BEFORE INSERT OR UPDATE OR DELETE ON "supplier_return_lines"
  FOR EACH ROW EXECUTE FUNCTION supplier_return_line_matches();

-- Never more returned than was accepted, across all posted returns; a
-- credit note comes from the same supplier in the same currency.
CREATE FUNCTION supplier_return_checks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'POSTED' AND OLD."status" = 'DRAFT' THEN
    IF EXISTS (
      SELECT 1 FROM "supplier_return_lines" l
      JOIN "goods_receipt_lines" gl ON gl."organization_id" = l."organization_id" AND gl."id" = l."receipt_line_id"
      WHERE l."organization_id" = NEW."organization_id" AND l."return_id" = NEW."id"
        AND (SELECT coalesce(sum(l2."quantity_base"), 0) FROM "supplier_return_lines" l2
               JOIN "supplier_returns" r2 ON r2."organization_id" = l2."organization_id" AND r2."id" = l2."return_id"
              WHERE l2."organization_id" = l."organization_id" AND l2."receipt_line_id" = l."receipt_line_id"
                AND (r2."status" IN ('POSTED', 'CREDITED') OR r2."id" = NEW."id")) > gl."accepted_quantity_base")
    THEN
      RAISE EXCEPTION 'more returned than was accepted on the receipt' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."credit_note_id" IS NOT NULL AND NEW."credit_note_id" IS DISTINCT FROM OLD."credit_note_id"
     AND NOT EXISTS (
       SELECT 1 FROM "supplier_settlements" s
       WHERE s."organization_id" = NEW."organization_id" AND s."id" = NEW."credit_note_id"
         AND s."kind" = 'CREDIT_NOTE' AND s."status" = 'POSTED'
         AND s."supplier_id" = NEW."supplier_id" AND s."currency" = NEW."currency") THEN
    RAISE EXCEPTION 'the credit note must be a posted credit note from this supplier in the return''s currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_returns_checks" BEFORE UPDATE ON "supplier_returns"
  FOR EACH ROW EXECUTE FUNCTION supplier_return_checks();

GRANT SELECT, INSERT, UPDATE ON "supplier_returns" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_return_lines" TO fa_tenant;
ALTER TABLE "supplier_returns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_returns" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "supplier_return_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_return_lines" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
