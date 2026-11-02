-- Currency per company, step 3b: customer receipts and revaluations per company (ADR-086).

ALTER TABLE "customer_receipts" ADD COLUMN     "company_id" UUID;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (ADR-086) --------------------------------------------------------
ALTER TABLE "customer_receipts" DISABLE TRIGGER USER;
UPDATE "customer_receipts" r SET "company_id" = COALESCE(
  (SELECT i."company_id" FROM "customer_receipt_allocations" a JOIN "sales_invoices" i ON i."id" = a."invoice_id"
   WHERE a."receipt_id" = r."id" LIMIT 1),
  (SELECT c."id" FROM "companies" c WHERE c."organization_id" = r."organization_id" AND c."is_default"));
ALTER TABLE "customer_receipts" ENABLE TRIGGER USER;
ALTER TABLE "customer_receipts" ALTER COLUMN "company_id" SET NOT NULL;
CREATE TRIGGER "customer_receipts_company" BEFORE INSERT ON "customer_receipts" FOR EACH ROW EXECUTE FUNCTION "company_default"();
CREATE TRIGGER "customer_receipts_company_fixed" BEFORE UPDATE ON "customer_receipts" FOR EACH ROW EXECUTE FUNCTION "company_fixed"();

CREATE FUNCTION "customer_receipt_allocation_company"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT "company_id" FROM "customer_receipts" WHERE "id" = NEW."receipt_id")
     IS DISTINCT FROM (SELECT "company_id" FROM "sales_invoices" WHERE "id" = NEW."invoice_id") THEN
    RAISE EXCEPTION 'the invoice belongs to another company' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "customer_receipt_allocations_company" BEFORE INSERT OR UPDATE ON "customer_receipt_allocations"
  FOR EACH ROW EXECUTE FUNCTION "customer_receipt_allocation_company"();

-- One revaluation per company and date unless cancelled.
DROP INDEX "fx_revaluations_as_of";
CREATE UNIQUE INDEX "fx_revaluations_as_of" ON "fx_revaluations" ("organization_id", "company_id", "as_of")
  WHERE "cancelled_at" IS NULL;
