
-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "pos_orders" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "company_id" UUID;

-- AlterTable
ALTER TABLE "supplier_invoices" ADD COLUMN     "company_id" UUID;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (ADR-083) --------------------------------------------------------
-- Every money document carries its legal entity. The database sets it from
-- the document's site, so no code path can forget it, and it never changes.

-- Backfill existing documents (their own "fixed" triggers are paused meanwhile).
ALTER TABLE "pos_orders" DISABLE TRIGGER USER;
ALTER TABLE "purchase_orders" DISABLE TRIGGER USER;
ALTER TABLE "goods_receipts" DISABLE TRIGGER USER;
ALTER TABLE "sales_orders" DISABLE TRIGGER USER;
ALTER TABLE "sales_invoices" DISABLE TRIGGER USER;
ALTER TABLE "supplier_invoices" DISABLE TRIGGER USER;

UPDATE "pos_orders" o SET "company_id" = b."company_id" FROM "branches" b WHERE b."id" = o."branch_id";
UPDATE "purchase_orders" p SET "company_id" = b."company_id"
  FROM "warehouses" w JOIN "branches" b ON b."id" = w."branch_id" WHERE w."id" = p."warehouse_id";
UPDATE "goods_receipts" g SET "company_id" = b."company_id"
  FROM "warehouses" w JOIN "branches" b ON b."id" = w."branch_id" WHERE w."id" = g."warehouse_id";
UPDATE "sales_orders" s SET "company_id" = b."company_id"
  FROM "warehouses" w JOIN "branches" b ON b."id" = w."branch_id" WHERE w."id" = s."warehouse_id";
UPDATE "sales_invoices" i SET "company_id" = so."company_id"
  FROM "customer_deliveries" d JOIN "sales_orders" so ON so."id" = d."order_id" WHERE d."id" = i."delivery_id";
-- Supplier invoices: the company of a matched receipt or order line, else the default company.
UPDATE "supplier_invoices" i SET "company_id" = COALESCE(
  (SELECT g."company_id" FROM "supplier_invoice_lines" l
     JOIN "goods_receipt_lines" gl ON gl."id" = l."receipt_line_id"
     JOIN "goods_receipts" g ON g."id" = gl."receipt_id"
   WHERE l."invoice_id" = i."id" LIMIT 1),
  (SELECT p."company_id" FROM "supplier_invoice_lines" l
     JOIN "purchase_order_lines" pl ON pl."id" = l."purchase_order_line_id"
     JOIN "purchase_orders" p ON p."id" = pl."purchase_order_id"
   WHERE l."invoice_id" = i."id" LIMIT 1),
  (SELECT c."id" FROM "companies" c WHERE c."organization_id" = i."organization_id" AND c."is_default"));

ALTER TABLE "pos_orders" ENABLE TRIGGER USER;
ALTER TABLE "purchase_orders" ENABLE TRIGGER USER;
ALTER TABLE "goods_receipts" ENABLE TRIGGER USER;
ALTER TABLE "sales_orders" ENABLE TRIGGER USER;
ALTER TABLE "sales_invoices" ENABLE TRIGGER USER;
ALTER TABLE "supplier_invoices" ENABLE TRIGGER USER;

ALTER TABLE "pos_orders" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "purchase_orders" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "goods_receipts" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "sales_orders" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "sales_invoices" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "supplier_invoices" ALTER COLUMN "company_id" SET NOT NULL;

-- Set on insert from the site.
CREATE FUNCTION "company_from_branch"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."company_id" := (SELECT "company_id" FROM "branches" WHERE "id" = NEW."branch_id");
  RETURN NEW;
END $$;
CREATE FUNCTION "company_from_warehouse"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."company_id" := (SELECT b."company_id" FROM "warehouses" w JOIN "branches" b ON b."id" = w."branch_id"
                       WHERE w."id" = NEW."warehouse_id");
  RETURN NEW;
END $$;
CREATE FUNCTION "company_from_delivery"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."company_id" := (SELECT so."company_id" FROM "customer_deliveries" d JOIN "sales_orders" so ON so."id" = d."order_id"
                       WHERE d."id" = NEW."delivery_id");
  RETURN NEW;
END $$;
CREATE FUNCTION "company_default"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."company_id" IS NULL THEN
    NEW."company_id" := (SELECT "id" FROM "companies" WHERE "organization_id" = NEW."organization_id" AND "is_default");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pos_orders_company" BEFORE INSERT ON "pos_orders" FOR EACH ROW EXECUTE FUNCTION "company_from_branch"();
CREATE TRIGGER "purchase_orders_company" BEFORE INSERT ON "purchase_orders" FOR EACH ROW EXECUTE FUNCTION "company_from_warehouse"();
CREATE TRIGGER "goods_receipts_company" BEFORE INSERT ON "goods_receipts" FOR EACH ROW EXECUTE FUNCTION "company_from_warehouse"();
CREATE TRIGGER "sales_orders_company" BEFORE INSERT ON "sales_orders" FOR EACH ROW EXECUTE FUNCTION "company_from_warehouse"();
CREATE TRIGGER "sales_invoices_company" BEFORE INSERT ON "sales_invoices" FOR EACH ROW EXECUTE FUNCTION "company_from_delivery"();
CREATE TRIGGER "supplier_invoices_company" BEFORE INSERT ON "supplier_invoices" FOR EACH ROW EXECUTE FUNCTION "company_default"();

-- Never changes afterwards.
CREATE FUNCTION "company_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."company_id" IS DISTINCT FROM OLD."company_id" THEN
    RAISE EXCEPTION '% keeps its company', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pos_orders_company_fixed" BEFORE UPDATE ON "pos_orders" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();
CREATE TRIGGER "purchase_orders_company_fixed" BEFORE UPDATE ON "purchase_orders" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();
CREATE TRIGGER "goods_receipts_company_fixed" BEFORE UPDATE ON "goods_receipts" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();
CREATE TRIGGER "sales_orders_company_fixed" BEFORE UPDATE ON "sales_orders" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();
CREATE TRIGGER "sales_invoices_company_fixed" BEFORE UPDATE ON "sales_invoices" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();
CREATE TRIGGER "supplier_invoices_company_fixed" BEFORE UPDATE ON "supplier_invoices" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();

-- A supplier invoice matches receipts and orders of its own company only.
CREATE FUNCTION "supplier_invoice_line_company"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv uuid; other uuid;
BEGIN
  SELECT "company_id" INTO inv FROM "supplier_invoices" WHERE "id" = NEW."invoice_id";
  IF NEW."receipt_line_id" IS NOT NULL THEN
    SELECT g."company_id" INTO other FROM "goods_receipt_lines" gl JOIN "goods_receipts" g ON g."id" = gl."receipt_id"
      WHERE gl."id" = NEW."receipt_line_id";
    IF other IS DISTINCT FROM inv THEN
      RAISE EXCEPTION 'receipt belongs to another company' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."purchase_order_line_id" IS NOT NULL THEN
    SELECT p."company_id" INTO other FROM "purchase_order_lines" pl JOIN "purchase_orders" p ON p."id" = pl."purchase_order_id"
      WHERE pl."id" = NEW."purchase_order_line_id";
    IF other IS DISTINCT FROM inv THEN
      RAISE EXCEPTION 'order belongs to another company' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "supplier_invoice_lines_company" BEFORE INSERT OR UPDATE ON "supplier_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "supplier_invoice_line_company"();

CREATE INDEX "pos_orders_company_idx" ON "pos_orders" ("organization_id", "company_id", "business_date");
CREATE INDEX "supplier_invoices_company_idx" ON "supplier_invoices" ("organization_id", "company_id");
