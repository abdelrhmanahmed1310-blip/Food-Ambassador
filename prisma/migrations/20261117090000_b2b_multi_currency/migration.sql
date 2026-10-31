-- B2B sales in foreign currencies (ADR-054). Existing documents were in the
-- base currency at rate 1.

ALTER TABLE "customers" ADD COLUMN "currency" CHAR(3);
ALTER TABLE "customers" ADD CONSTRAINT "customers_currency_ck" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');

ALTER TABLE "sales_orders" ADD COLUMN "currency" CHAR(3);
UPDATE "sales_orders" s SET "currency" = o."base_currency" FROM "organizations" o WHERE o."id" = s."organization_id";
ALTER TABLE "sales_orders" ALTER COLUMN "currency" SET NOT NULL;

ALTER TABLE "sales_invoices" ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "exchange_rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
  ADD COLUMN "rate_date" DATE,
  ADD COLUMN "net_amount_base" DECIMAL(19,4),
  ADD COLUMN "tax_amount_base" DECIMAL(19,4),
  ADD COLUMN "gross_amount_base" DECIMAL(19,4);
ALTER TABLE "sales_invoices" DISABLE TRIGGER "sales_invoices_fixed";
UPDATE "sales_invoices" i SET "currency" = o."base_currency", "net_amount_base" = i."net_amount",
    "tax_amount_base" = i."tax_amount", "gross_amount_base" = i."gross_amount"
  FROM "organizations" o WHERE o."id" = i."organization_id";
ALTER TABLE "sales_invoices" ENABLE TRIGGER "sales_invoices_fixed";
ALTER TABLE "sales_invoices" ALTER COLUMN "currency" SET NOT NULL,
  ALTER COLUMN "net_amount_base" SET NOT NULL,
  ALTER COLUMN "tax_amount_base" SET NOT NULL,
  ALTER COLUMN "gross_amount_base" SET NOT NULL;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_fx_ck"
  CHECK ("exchange_rate" > 0 AND "gross_amount_base" = "net_amount_base" + "tax_amount_base");

ALTER TABLE "customer_receipts" ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "exchange_rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
  ADD COLUMN "rate_date" DATE,
  ADD COLUMN "amount_base" DECIMAL(19,4);
ALTER TABLE "customer_receipts" DISABLE TRIGGER "customer_receipts_fixed";
UPDATE "customer_receipts" r SET "currency" = o."base_currency", "amount_base" = r."amount"
  FROM "organizations" o WHERE o."id" = r."organization_id";
ALTER TABLE "customer_receipts" ENABLE TRIGGER "customer_receipts_fixed";
ALTER TABLE "customer_receipts" ALTER COLUMN "currency" SET NOT NULL,
  ALTER COLUMN "amount_base" SET NOT NULL;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_fx_ck" CHECK ("exchange_rate" > 0);

ALTER TABLE "customer_receipt_allocations" ADD COLUMN "fx_difference_base" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- A receipt settles invoices of the same customer and currency only.
CREATE FUNCTION "customer_allocation_consistent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; i record;
BEGIN
  SELECT "customer_id", "status", "currency" INTO r FROM "customer_receipts" WHERE "id" = NEW."receipt_id";
  SELECT "customer_id", "status", "currency" INTO i FROM "sales_invoices" WHERE "id" = NEW."invoice_id";
  IF r."status" <> 'POSTED' OR i."status" <> 'POSTED' OR r."customer_id" <> i."customer_id"
     OR r."currency" <> i."currency" THEN
    RAISE EXCEPTION 'allocation must link a posted receipt and a posted invoice of the same customer and currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "customer_receipt_allocations_consistent" BEFORE INSERT ON "customer_receipt_allocations"
  FOR EACH ROW EXECUTE FUNCTION "customer_allocation_consistent"();
