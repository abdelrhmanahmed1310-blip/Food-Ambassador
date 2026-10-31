-- Multi-currency purchasing (ADR-050, Q-05/Q-11): document currency, the
-- rate fixed on the document date, and base-currency equivalents.

CREATE TYPE "ExchangeRateSource" AS ENUM ('MANUAL', 'CSV');

CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rate_date" DATE NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "source" "ExchangeRateSource" NOT NULL DEFAULT 'MANUAL',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "exchange_rates_organization_id_currency_rate_date_key" ON "exchange_rates"("organization_id", "currency", "rate_date");
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_values_ck"
  CHECK ("rate" > 0 AND "currency" ~ '^[A-Z]{3}$');

ALTER TABLE "accounting_settings" ADD COLUMN "fx_difference_account" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "currency" CHAR(3);
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_currency_ck" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');

ALTER TABLE "purchase_orders" ADD COLUMN "exchange_rate" DECIMAL(20,10),
  ADD COLUMN "total_amount_base" DECIMAL(19,4);
-- Orders so far were all in the base currency.
UPDATE "purchase_orders" SET "exchange_rate" = 1, "total_amount_base" = "total_amount"
 WHERE "submitted_at" IS NOT NULL;

ALTER TABLE "goods_receipts" ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "exchange_rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
  ADD COLUMN "rate_date" DATE;
UPDATE "goods_receipts" g SET "currency" = o."base_currency"
  FROM "organizations" o WHERE o."id" = g."organization_id";
ALTER TABLE "goods_receipts" ALTER COLUMN "currency" SET NOT NULL;

ALTER TABLE "supplier_invoices" ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "exchange_rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
  ADD COLUMN "rate_date" DATE,
  ADD COLUMN "net_amount_base" DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN "tax_amount_base" DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN "gross_amount_base" DECIMAL(19,4) NOT NULL DEFAULT 0;
UPDATE "supplier_invoices" i SET "currency" = o."base_currency",
    "net_amount_base" = i."net_amount", "tax_amount_base" = i."tax_amount",
    "gross_amount_base" = i."gross_amount"
  FROM "organizations" o WHERE o."id" = i."organization_id";
ALTER TABLE "supplier_invoices" ALTER COLUMN "currency" SET NOT NULL;

ALTER TABLE "supplier_settlements" ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "exchange_rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
  ADD COLUMN "rate_date" DATE,
  ADD COLUMN "amount_base" DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN "tax_amount_base" DECIMAL(19,4) NOT NULL DEFAULT 0;
-- Settlements are otherwise fixed (only voiding is allowed): backfill with the guard off.
ALTER TABLE "supplier_settlements" DISABLE TRIGGER "supplier_settlements_void_only";
UPDATE "supplier_settlements" s SET "currency" = o."base_currency",
    "amount_base" = s."amount", "tax_amount_base" = s."tax_amount"
  FROM "organizations" o WHERE o."id" = s."organization_id";
ALTER TABLE "supplier_settlements" ENABLE TRIGGER "supplier_settlements_void_only";
ALTER TABLE "supplier_settlements" ALTER COLUMN "currency" SET NOT NULL;

ALTER TABLE "settlement_allocations" ADD COLUMN "fx_difference_base" DECIMAL(19,4) NOT NULL DEFAULT 0;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_fx_ck" CHECK ("exchange_rate" > 0);
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_fx_ck" CHECK ("exchange_rate" > 0);
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_fx_ck" CHECK ("exchange_rate" > 0);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_fx_ck" CHECK ("exchange_rate" IS NULL OR "exchange_rate" > 0);

-- Allocations link a settlement and an invoice of the same supplier AND currency.
CREATE OR REPLACE FUNCTION "settlement_allocation_consistent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; i record;
BEGIN
  SELECT "supplier_id", "status", "currency" INTO s FROM "supplier_settlements" WHERE "id" = NEW."settlement_id";
  SELECT "supplier_id", "status", "currency" INTO i FROM "supplier_invoices" WHERE "id" = NEW."invoice_id";
  IF s."status" <> 'POSTED' OR i."status" <> 'POSTED' OR s."supplier_id" <> i."supplier_id"
     OR s."currency" <> i."currency" THEN
    RAISE EXCEPTION 'allocation must link a posted settlement and a posted invoice of the same supplier and currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "exchange_rates" TO fa_tenant;
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "exchange_rates"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

-- Who maintains exchange rates (ADR-050).
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'fx.manage'), ('finance', 'fx.manage')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
