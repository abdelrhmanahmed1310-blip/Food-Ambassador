-- CreateEnum
CREATE TYPE "UnitDimension" AS ENUM ('MASS', 'VOLUME', 'COUNT');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED_GOOD', 'PACKAGING', 'CONSUMABLE');

-- CreateEnum
CREATE TYPE "LotTracking" AS ENUM ('NONE', 'LOT', 'LOT_AND_EXPIRY');

-- CreateEnum
CREATE TYPE "BarcodeSymbology" AS ENUM ('EAN13', 'EAN8', 'UPC_A', 'CODE128', 'QR', 'INTERNAL');

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('AVAILABLE', 'QUARANTINE', 'REJECTED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('OPENING_BALANCE', 'RECEIPT', 'RECEIPT_REJECTED', 'TRANSFER_OUT', 'TRANSFER_IN', 'CONSUMPTION', 'PRODUCTION_OUTPUT', 'RETURN_TO_SUPPLIER', 'CUSTOMER_RETURN', 'WRITE_OFF', 'ADJUSTMENT', 'COUNT_ADJUSTMENT', 'STATUS_CHANGE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "InventoryDocumentType" AS ENUM ('OPENING_BALANCE', 'ADJUSTMENT', 'WRITE_OFF', 'TRANSFER', 'STATUS_CHANGE', 'STOCK_COUNT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'SUBMITTED', 'POSTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "dimension" "UnitDimension" NOT NULL,
    "factor_to_base" DECIMAL(30,12),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT,
    "type" "ProductType" NOT NULL,
    "base_uom_id" UUID NOT NULL,
    "lot_tracking" "LotTracking" NOT NULL DEFAULT 'NONE',
    "shelf_life_days" INTEGER,
    "storage_requirement" "TemperatureZone" NOT NULL DEFAULT 'AMBIENT',
    "archived_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_barcodes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "barcode" TEXT NOT NULL,
    "symbology" "BarcodeSymbology" NOT NULL,
    "uom_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_uom_conversions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "uom_id" UUID NOT NULL,
    "factor_to_base" DECIMAL(30,12) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_uom_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_lots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_code" TEXT NOT NULL,
    "expires_on" DATE,
    "best_before_on" DATE,
    "manufactured_on" DATE,
    "first_received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recall_hold" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "type" "InventoryDocumentType" NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "destination_warehouse_id" UUID,
    "reason_code" TEXT,
    "note" TEXT,
    "reverses_document_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_by_user_id" UUID NOT NULL,

    CONSTRAINT "inventory_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_ledger_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "movement_type" "MovementType" NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "product_id" UUID NOT NULL,
    "lot_id" UUID,
    "stock_status" "StockStatus" NOT NULL,
    "quantity_delta" DECIMAL(20,6) NOT NULL,
    "entered_quantity" DECIMAL(20,6) NOT NULL,
    "entered_uom_id" UUID NOT NULL,
    "unit_cost" DECIMAL(20,6),
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "source_line_id" UUID,
    "posting_key" TEXT NOT NULL,
    "reverses_entry_id" UUID,
    "reason_code" TEXT,
    "note" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_by_user_id" UUID NOT NULL,

    CONSTRAINT "inventory_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "product_id" UUID NOT NULL,
    "lot_id" UUID,
    "stock_status" "StockStatus" NOT NULL,
    "on_hand_quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "reserved_quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "last_entry_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "organization_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next_value" INTEGER NOT NULL,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("organization_id","document_type","year")
);

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "snapshot_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "document_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "submitted_by_user_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "posted_by_user_id" UUID,
    "posted_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID,
    "location_id" UUID,
    "expected_quantity" DECIMAL(20,6) NOT NULL,
    "counted_quantity" DECIMAL(20,6),
    "counted_by_user_id" UUID,
    "counted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_code_key" ON "units_of_measure"("organization_id", "code") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_id_key" ON "products"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_sku_key" ON "products"("organization_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_organization_id_id_key" ON "product_barcodes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_organization_id_barcode_key" ON "product_barcodes"("organization_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "product_uom_conversions_organization_id_id_key" ON "product_uom_conversions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_uom_conversions_organization_id_product_id_uom_id_key" ON "product_uom_conversions"("organization_id", "product_id", "uom_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lots_organization_id_id_key" ON "inventory_lots"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lots_organization_id_product_id_id_key" ON "inventory_lots"("organization_id", "product_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lots_organization_id_product_id_lot_code_key" ON "inventory_lots"("organization_id", "product_id", "lot_code");

-- CreateIndex
CREATE INDEX "inventory_documents_organization_id_posted_at_idx" ON "inventory_documents"("organization_id", "posted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_organization_id_id_key" ON "inventory_documents"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_organization_id_number_key" ON "inventory_documents"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_organization_id_reverses_document_id_key" ON "inventory_documents"("organization_id", "reverses_document_id");

-- CreateIndex
CREATE INDEX "inventory_ledger_entries_organization_id_product_id_warehou_idx" ON "inventory_ledger_entries"("organization_id", "product_id", "warehouse_id", "posted_at");

-- CreateIndex
CREATE INDEX "inventory_ledger_entries_organization_id_lot_id_idx" ON "inventory_ledger_entries"("organization_id", "lot_id");

-- CreateIndex
CREATE INDEX "inventory_ledger_entries_organization_id_document_id_idx" ON "inventory_ledger_entries"("organization_id", "document_id");

-- CreateIndex
CREATE INDEX "inventory_ledger_entries_organization_id_posted_at_idx" ON "inventory_ledger_entries"("organization_id", "posted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entries_organization_id_id_key" ON "inventory_ledger_entries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entries_organization_id_posting_key_key" ON "inventory_ledger_entries"("organization_id", "posting_key");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entries_organization_id_reverses_entry_id_key" ON "inventory_ledger_entries"("organization_id", "reverses_entry_id");

-- CreateIndex
CREATE INDEX "stock_balances_organization_id_product_id_idx" ON "stock_balances"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_balances_organization_id_warehouse_id_idx" ON "stock_balances"("organization_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_organization_id_id_key" ON "stock_balances"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_bucket_key" ON "stock_balances"("organization_id", "warehouse_id", "location_id", "product_id", "lot_id", "stock_status") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "stock_counts_organization_id_status_idx" ON "stock_counts"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_organization_id_id_key" ON "stock_counts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_organization_id_number_key" ON "stock_counts"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_organization_id_document_id_key" ON "stock_counts"("organization_id", "document_id");

-- CreateIndex
CREATE INDEX "stock_count_lines_organization_id_count_id_idx" ON "stock_count_lines"("organization_id", "count_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_lines_organization_id_id_key" ON "stock_count_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_lines_item_key" ON "stock_count_lines"("count_id", "product_id", "lot_id", "location_id") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_organization_id_warehouse_id_id_key" ON "storage_locations"("organization_id", "warehouse_id", "id");

-- AddForeignKey
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_base_uom_id_fkey" FOREIGN KEY ("base_uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uom_conversions" ADD CONSTRAINT "product_uom_conversions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uom_conversions" ADD CONSTRAINT "product_uom_conversions_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uom_conversions" ADD CONSTRAINT "product_uom_conversions_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_organization_id_destination_warehouse__fkey" FOREIGN KEY ("organization_id", "destination_warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_documents" ADD CONSTRAINT "inventory_documents_organization_id_reverses_document_id_fkey" FOREIGN KEY ("organization_id", "reverses_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_organization_id_warehouse_id_loca_fkey" FOREIGN KEY ("organization_id", "warehouse_id", "location_id") REFERENCES "storage_locations"("organization_id", "warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_entered_uom_id_fkey" FOREIGN KEY ("entered_uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_organization_id_reverses_entry_id_fkey" FOREIGN KEY ("organization_id", "reverses_entry_id") REFERENCES "inventory_ledger_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_warehouse_id_location_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id", "location_id") REFERENCES "storage_locations"("organization_id", "warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_organization_id_warehouse_id_location_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id", "location_id") REFERENCES "storage_locations"("organization_id", "warehouse_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_organization_id_count_id_fkey" FOREIGN KEY ("organization_id", "count_id") REFERENCES "stock_counts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "storage_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ════════════════════════════════════════════════════════════════════════
-- Hand-written constraints, triggers, RLS and reference data (Milestone 2)
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_factor_ck" CHECK ("factor_to_base" IS NULL OR "factor_to_base" > 0);
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_code_ck" CHECK ("code" ~ '^[a-z0-9][a-z0-9_-]{0,19}$');
ALTER TABLE "product_uom_conversions" ADD CONSTRAINT "product_uom_conversions_factor_ck" CHECK ("factor_to_base" > 0);
ALTER TABLE "products" ADD CONSTRAINT "products_shelf_life_ck" CHECK ("shelf_life_days" IS NULL OR "shelf_life_days" > 0);

-- Ledger: non-zero movement, entered quantity has the same sign.
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_delta_ck"
  CHECK ("quantity_delta" <> 0 AND sign("entered_quantity") = sign("quantity_delta"));
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_cost_ck"
  CHECK ("unit_cost" IS NULL OR "unit_cost" >= 0);

-- Balances: no negative stock, reservations within on-hand (ADR-005, A-06).
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_on_hand_ck" CHECK ("on_hand_quantity" >= 0);
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_reserved_ck"
  CHECK ("reserved_quantity" >= 0 AND "reserved_quantity" <= "on_hand_quantity");

ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_counted_ck"
  CHECK ("counted_quantity" IS NULL OR "counted_quantity" >= 0);
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_next_ck" CHECK ("next_value" >= 1);
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Posted inventory history is immutable: corrections are reversal documents.
CREATE TRIGGER "inventory_ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "inventory_ledger_entries_no_truncate"
  BEFORE TRUNCATE ON "inventory_ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "inventory_documents_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_documents"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "inventory_documents_no_truncate"
  BEFORE TRUNCATE ON "inventory_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_modification"();

-- Units are global or tenant-owned, so plain FKs are used; this trigger makes
-- sure a row only ever references a system unit or a unit of its own tenant.
CREATE FUNCTION "assert_unit_visible"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unit_id uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  unit_org uuid;
BEGIN
  IF unit_id IS NULL THEN RETURN NEW; END IF;
  SELECT "organization_id" INTO unit_org FROM "units_of_measure" WHERE "id" = unit_id;
  IF unit_org IS NOT NULL AND unit_org <> NEW."organization_id" THEN
    RAISE EXCEPTION 'unit % belongs to another organization', unit_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "products_unit_visible" BEFORE INSERT OR UPDATE ON "products"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('base_uom_id');
CREATE TRIGGER "product_uom_conversions_unit_visible" BEFORE INSERT OR UPDATE ON "product_uom_conversions"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('uom_id');
CREATE TRIGGER "product_barcodes_unit_visible" BEFORE INSERT OR UPDATE ON "product_barcodes"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('uom_id');
CREATE TRIGGER "inventory_ledger_entries_unit_visible" BEFORE INSERT ON "inventory_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('entered_uom_id');

-- ─── Row-level security and grants for the tenant role ───

GRANT SELECT, INSERT, UPDATE ON "units_of_measure", "products", "stock_balances", "stock_counts", "stock_count_lines", "document_sequences" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "product_barcodes", "product_uom_conversions" TO fa_tenant;
GRANT SELECT, INSERT ON "inventory_lots", "inventory_documents", "inventory_ledger_entries" TO fa_tenant;

-- System units (organization_id NULL) are readable by every tenant but never writable.
ALTER TABLE "units_of_measure" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "units_of_measure"
  USING ("organization_id" IS NULL OR "organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products', 'product_barcodes', 'product_uom_conversions', 'inventory_lots',
    'inventory_documents', 'inventory_ledger_entries', 'stock_balances', 'stock_counts', 'stock_count_lines',
    'document_sequences']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- ─── System units of measure ───
-- Base units per dimension: g (MASS), ml (VOLUME), each (COUNT).

INSERT INTO "units_of_measure" ("id", "organization_id", "code", "name_en", "name_ar", "dimension", "factor_to_base") VALUES
  (gen_random_uuid(), NULL, 'mg',    'Milligram',  'ملليغرام', 'MASS',   0.001),
  (gen_random_uuid(), NULL, 'g',     'Gram',       'غرام',     'MASS',   1),
  (gen_random_uuid(), NULL, 'kg',    'Kilogram',   'كيلوغرام', 'MASS',   1000),
  (gen_random_uuid(), NULL, 'oz',    'Ounce',      'أونصة',    'MASS',   28.349523125),
  (gen_random_uuid(), NULL, 'lb',    'Pound',      'رطل',      'MASS',   453.59237),
  (gen_random_uuid(), NULL, 'ml',    'Millilitre', 'ملليلتر',  'VOLUME', 1),
  (gen_random_uuid(), NULL, 'l',     'Litre',      'لتر',      'VOLUME', 1000),
  (gen_random_uuid(), NULL, 'each',  'Each',       'قطعة',     'COUNT',  1),
  (gen_random_uuid(), NULL, 'dozen', 'Dozen',      'دستة',     'COUNT',  12);

-- ─── New permissions for existing organizations' system roles ───
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'catalog.view'), ('admin', 'catalog.manage'), ('admin', 'inventory.view'), ('admin', 'inventory.adjust'),
  ('admin', 'inventory.transfer'), ('admin', 'inventory.count'), ('admin', 'inventory.count.approve'),
  ('admin', 'inventory.quarantine'), ('admin', 'inventory.quarantine.release'), ('admin', 'inventory.reverse'),
  ('operations_manager', 'catalog.view'), ('operations_manager', 'catalog.manage'), ('operations_manager', 'inventory.view'),
  ('operations_manager', 'inventory.adjust'), ('operations_manager', 'inventory.transfer'), ('operations_manager', 'inventory.count'),
  ('operations_manager', 'inventory.count.approve'), ('operations_manager', 'inventory.quarantine'),
  ('operations_manager', 'inventory.quarantine.release'), ('operations_manager', 'inventory.reverse'),
  ('procurement', 'catalog.view'), ('procurement', 'catalog.manage'), ('procurement', 'inventory.view'),
  ('warehouse', 'catalog.view'), ('warehouse', 'inventory.view'), ('warehouse', 'inventory.transfer'),
  ('warehouse', 'inventory.count'), ('warehouse', 'inventory.quarantine'),
  ('food_safety', 'catalog.view'), ('food_safety', 'inventory.view'), ('food_safety', 'inventory.quarantine'),
  ('food_safety', 'inventory.quarantine.release'),
  ('finance', 'catalog.view'), ('finance', 'inventory.view'),
  ('branch_manager', 'catalog.view'), ('branch_manager', 'inventory.view'), ('branch_manager', 'inventory.adjust'),
  ('branch_manager', 'inventory.transfer'), ('branch_manager', 'inventory.count'), ('branch_manager', 'inventory.count.approve'),
  ('branch_manager', 'inventory.quarantine'), ('branch_manager', 'inventory.reverse'),
  ('analyst', 'catalog.view'), ('analyst', 'inventory.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
