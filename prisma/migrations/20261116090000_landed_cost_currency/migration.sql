-- Landed costs entered in a foreign currency (ADR-053). `amount` stays the
-- base-currency value posted to stock; existing charges were in base.
ALTER TABLE "landed_costs" ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "entered_amount" DECIMAL(19,4),
  ADD COLUMN "exchange_rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
  ADD COLUMN "rate_date" DATE;
-- Landed costs are append-only: backfill with the guard off.
ALTER TABLE "landed_costs" DISABLE TRIGGER "landed_costs_append_only";
UPDATE "landed_costs" l SET "currency" = o."base_currency", "entered_amount" = l."amount"
  FROM "organizations" o WHERE o."id" = l."organization_id";
ALTER TABLE "landed_costs" ENABLE TRIGGER "landed_costs_append_only";
ALTER TABLE "landed_costs" ALTER COLUMN "currency" SET NOT NULL,
  ALTER COLUMN "entered_amount" SET NOT NULL;
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_fx_ck"
  CHECK ("exchange_rate" > 0 AND "entered_amount" > 0 AND "currency" ~ '^[A-Z]{3}$');
