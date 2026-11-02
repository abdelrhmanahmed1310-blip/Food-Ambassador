-- Currency per company, step 3b: purchasing and payables (ADR-086).

ALTER TABLE "fx_revaluations" ADD COLUMN     "company_id" UUID;
ALTER TABLE "supplier_settlements" ADD COLUMN     "company_id" UUID;
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (ADR-086) --------------------------------------------------------
-- A payment or credit note belongs to the company it settles for: existing
-- ones to the company of an invoice they were applied to, else the default.
ALTER TABLE "supplier_settlements" DISABLE TRIGGER USER;
UPDATE "supplier_settlements" s SET "company_id" = COALESCE(
  (SELECT i."company_id" FROM "settlement_allocations" a JOIN "supplier_invoices" i ON i."id" = a."invoice_id"
   WHERE a."settlement_id" = s."id" LIMIT 1),
  (SELECT c."id" FROM "companies" c WHERE c."organization_id" = s."organization_id" AND c."is_default"));
ALTER TABLE "supplier_settlements" ENABLE TRIGGER USER;
ALTER TABLE "fx_revaluations" DISABLE TRIGGER USER;
UPDATE "fx_revaluations" r SET "company_id" = c."id"
  FROM "companies" c WHERE c."organization_id" = r."organization_id" AND c."is_default";
ALTER TABLE "fx_revaluations" ENABLE TRIGGER USER;
ALTER TABLE "supplier_settlements" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "fx_revaluations" ALTER COLUMN "company_id" SET NOT NULL;

CREATE TRIGGER "supplier_settlements_company" BEFORE INSERT ON "supplier_settlements" FOR EACH ROW EXECUTE FUNCTION "company_default"();
CREATE TRIGGER "fx_revaluations_company" BEFORE INSERT ON "fx_revaluations" FOR EACH ROW EXECUTE FUNCTION "company_default"();
CREATE TRIGGER "supplier_settlements_company_fixed" BEFORE UPDATE ON "supplier_settlements" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();
CREATE TRIGGER "fx_revaluations_company_fixed" BEFORE UPDATE ON "fx_revaluations" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();

-- A settlement pays only invoices of its own company.
CREATE FUNCTION "settlement_allocation_company"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT "company_id" FROM "supplier_settlements" WHERE "id" = NEW."settlement_id")
     IS DISTINCT FROM (SELECT "company_id" FROM "supplier_invoices" WHERE "id" = NEW."invoice_id") THEN
    RAISE EXCEPTION 'the invoice belongs to another company' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "settlement_allocations_company" BEFORE INSERT OR UPDATE ON "settlement_allocations"
  FOR EACH ROW EXECUTE FUNCTION "settlement_allocation_company"();

CREATE INDEX "supplier_settlements_company_idx" ON "supplier_settlements" ("organization_id", "company_id", "supplier_id");

-- Purchasing and payables now keep amounts in the company's currency.
DROP TRIGGER "purchase_orders_currency_guard" ON "purchase_orders";
DROP TRIGGER "goods_receipts_currency_guard" ON "goods_receipts";
DROP TRIGGER "supplier_invoices_currency_guard" ON "supplier_invoices";
