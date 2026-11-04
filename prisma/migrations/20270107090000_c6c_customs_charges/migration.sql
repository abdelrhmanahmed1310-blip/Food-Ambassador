-- AlterTable
ALTER TABLE "landed_costs" ADD COLUMN     "shipment_charge_id" UUID;

-- CreateTable
CREATE TABLE "import_customs_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "declared_on" DATE NOT NULL,
    "broker" TEXT,
    "currency" CHAR(3) NOT NULL,
    "customs_value" DECIMAL(19,4),
    "duty_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "import_vat" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_customs_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_shipment_charges" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "customs_entry_id" UUID,
    "charge_type" "LandedCostCharge" NOT NULL,
    "method" "LandedCostMethod" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "entered_amount" DECIMAL(19,4) NOT NULL,
    "exchange_rate" DECIMAL(20,10) NOT NULL DEFAULT 1,
    "rate_date" DATE,
    "amount" DECIMAL(19,4) NOT NULL,
    "capitalized_amount" DECIMAL(19,4) NOT NULL,
    "expensed_amount" DECIMAL(19,4) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "posted_by_user_id" UUID NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_shipment_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_customs_entries_organization_id_id_key" ON "import_customs_entries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "import_customs_entries_organization_id_shipment_id_number_key" ON "import_customs_entries"("organization_id", "shipment_id", "number");

-- CreateIndex
CREATE INDEX "import_shipment_charges_organization_id_shipment_id_idx" ON "import_shipment_charges"("organization_id", "shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_shipment_charges_organization_id_id_key" ON "import_shipment_charges"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_organization_id_shipment_charge_id_fkey" FOREIGN KEY ("organization_id", "shipment_charge_id") REFERENCES "import_shipment_charges"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_customs_entries" ADD CONSTRAINT "import_customs_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_customs_entries" ADD CONSTRAINT "import_customs_entries_organization_id_shipment_id_fkey" FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "import_shipments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_charges" ADD CONSTRAINT "import_shipment_charges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_charges" ADD CONSTRAINT "import_shipment_charges_organization_id_shipment_id_fkey" FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "import_shipments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_charges" ADD CONSTRAINT "import_shipment_charges_organization_id_customs_entry_id_fkey" FOREIGN KEY ("organization_id", "customs_entry_id") REFERENCES "import_customs_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C6c customs entries and shipment charges (ADR-115): hand-written rules ───
ALTER TABLE "import_customs_entries" ADD CONSTRAINT "import_customs_entries_ck" CHECK (
  "currency" ~ '^[A-Z]{3}$' AND ("customs_value" IS NULL OR "customs_value" >= 0)
  AND "duty_amount" >= 0 AND "import_vat" >= 0);
ALTER TABLE "import_shipment_charges" ADD CONSTRAINT "import_shipment_charges_ck" CHECK (
  "amount" > 0 AND "entered_amount" > 0 AND "exchange_rate" > 0
  AND "capitalized_amount" >= 0 AND "expensed_amount" >= 0
  AND "capitalized_amount" + "expensed_amount" = "amount");

-- Append-only: customs entries and charges are never changed or removed.
GRANT SELECT, INSERT ON "import_customs_entries", "import_shipment_charges" TO fa_tenant;
CREATE OR REPLACE FUNCTION "import_charges_frozen"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'import customs entries and shipment charges are append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "import_customs_entries_frozen" BEFORE UPDATE OR DELETE ON "import_customs_entries"
  FOR EACH ROW EXECUTE FUNCTION "import_charges_frozen"();
CREATE TRIGGER "import_shipment_charges_frozen" BEFORE UPDATE OR DELETE ON "import_shipment_charges"
  FOR EACH ROW EXECUTE FUNCTION "import_charges_frozen"();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_customs_entries', 'import_shipment_charges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

-- A charge row is written after its per-receipt landed costs (it records their totals).
ALTER TABLE "landed_costs" ALTER CONSTRAINT "landed_costs_organization_id_shipment_charge_id_fkey"
  DEFERRABLE INITIALLY DEFERRED;
