-- CreateEnum
CREATE TYPE "DeliveryPayoutStatus" AS ENUM ('DRAFT', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "DeliveryPayoutMatch" AS ENUM ('MATCHED', 'AMOUNT_DIFFERS', 'NOT_FOUND', 'CANCELLED_ORDER', 'NOT_ACCEPTED', 'ALREADY_PAID', 'ADJUSTMENT');


-- CreateTable
CREATE TABLE "delivery_payouts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "paid_on" DATE,
    "status" "DeliveryPayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "gross" DECIMAL(19,4) NOT NULL,
    "commission" DECIMAL(19,4) NOT NULL,
    "fees" DECIMAL(19,4) NOT NULL,
    "vat_on_fees" DECIMAL(19,4) NOT NULL,
    "net" DECIMAL(19,4) NOT NULL,
    "received_amount" DECIMAL(19,4),
    "file_name" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by_user_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),

    CONSTRAINT "delivery_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_payout_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payout_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "external_id" TEXT,
    "description" TEXT,
    "gross" DECIMAL(19,4) NOT NULL,
    "commission" DECIMAL(19,4) NOT NULL,
    "fees" DECIMAL(19,4) NOT NULL,
    "vat_on_fees" DECIMAL(19,4) NOT NULL,
    "net" DECIMAL(19,4) NOT NULL,
    "match" "DeliveryPayoutMatch" NOT NULL,
    "delivery_order_id" UUID,
    "recorded_total" DECIMAL(19,4),
    "settled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "delivery_payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_payouts_organization_id_created_at_idx" ON "delivery_payouts"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_payouts_organization_id_id_key" ON "delivery_payouts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_payouts_connector_id_reference_key" ON "delivery_payouts"("connector_id", "reference");

-- CreateIndex
CREATE INDEX "delivery_payout_lines_organization_id_delivery_order_id_idx" ON "delivery_payout_lines"("organization_id", "delivery_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_payout_lines_payout_id_line_no_key" ON "delivery_payout_lines"("payout_id", "line_no");

-- AddForeignKey
ALTER TABLE "delivery_payouts" ADD CONSTRAINT "delivery_payouts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_payouts" ADD CONSTRAINT "delivery_payouts_organization_id_connector_id_fkey" FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_payout_lines" ADD CONSTRAINT "delivery_payout_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_payout_lines" ADD CONSTRAINT "delivery_payout_lines_organization_id_payout_id_fkey" FOREIGN KEY ("organization_id", "payout_id") REFERENCES "delivery_payouts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_payout_lines" ADD CONSTRAINT "delivery_payout_lines_organization_id_delivery_order_id_fkey" FOREIGN KEY ("organization_id", "delivery_order_id") REFERENCES "delivery_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (ADR-075) ------------------------------------------------------

ALTER TABLE "delivery_payouts" ADD CONSTRAINT "delivery_payouts_values_ck"
  CHECK (length("reference") BETWEEN 1 AND 100
    AND "period_from" <= "period_to"
    AND ("received_amount" IS NULL OR "received_amount" >= 0)
    AND ("status"::text = 'DRAFT') = ("confirmed_at" IS NULL)
    AND ("confirmed_at" IS NULL) = ("confirmed_by_user_id" IS NULL));

ALTER TABLE "delivery_payout_lines" ADD CONSTRAINT "delivery_payout_lines_values_ck"
  CHECK ("line_no" >= 1
    AND ("external_id" IS NULL OR length("external_id") BETWEEN 1 AND 100)
    AND ("external_id" IS NULL) = ("match"::text = 'ADJUSTMENT')
    AND ("delivery_order_id" IS NOT NULL OR "match"::text IN ('NOT_FOUND', 'ADJUSTMENT'))
    AND (NOT "settled" OR "match"::text IN ('MATCHED', 'AMOUNT_DIFFERS')));

-- One order is settled by at most one payout line.
CREATE UNIQUE INDEX "delivery_payout_lines_settled_uq"
  ON "delivery_payout_lines" ("delivery_order_id") WHERE "settled";

-- A confirmed payout and its lines are fixed: no change, no deletion.
CREATE FUNCTION "delivery_payout_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"::text = 'CONFIRMED' THEN
    RAISE EXCEPTION 'confirmed delivery payout % is fixed', OLD."id" USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER "delivery_payouts_fixed" BEFORE UPDATE OR DELETE ON "delivery_payouts"
  FOR EACH ROW EXECUTE FUNCTION "delivery_payout_fixed"();

CREATE FUNCTION "delivery_payout_line_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT "status"::text INTO s FROM "delivery_payouts" WHERE "id" = OLD."payout_id";
  IF s = 'CONFIRMED' THEN
    RAISE EXCEPTION 'lines of confirmed delivery payout % are fixed', OLD."payout_id" USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER "delivery_payout_lines_fixed" BEFORE UPDATE OR DELETE ON "delivery_payout_lines"
  FOR EACH ROW EXECUTE FUNCTION "delivery_payout_line_fixed"();

GRANT SELECT, INSERT, UPDATE, DELETE ON "delivery_payouts" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "delivery_payout_lines" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['delivery_payouts', 'delivery_payout_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
