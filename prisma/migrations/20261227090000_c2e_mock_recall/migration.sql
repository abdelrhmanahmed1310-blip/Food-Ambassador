-- CreateEnum
CREATE TYPE "MockRecallStatus" AS ENUM ('RUNNING', 'COMPLETED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "NcSource" ADD VALUE 'MOCK_RECALL';

-- CreateTable
CREATE TABLE "mock_recalls" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "scenario" TEXT NOT NULL,
    "target_minutes" INTEGER,
    "status" "MockRecallStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_by_user_id" UUID NOT NULL,
    "received_quantity" DECIMAL(20,6) NOT NULL,
    "exited_quantity" DECIMAL(20,6) NOT NULL,
    "on_hand_quantity" DECIMAL(20,6) NOT NULL,
    "gap_count" INTEGER NOT NULL,
    "supplier_count" INTEGER NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_user_id" UUID,
    "elapsed_seconds" INTEGER,
    "found_quantity" DECIMAL(20,6),
    "accounted_percent" DECIMAL(7,2),
    "within_target" BOOLEAN,
    "findings" TEXT,
    "non_conformance_id" UUID,
    "cancel_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mock_recalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_recall_counts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mock_recall_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "stock_status" "StockStatus" NOT NULL,
    "book_quantity" DECIMAL(20,6) NOT NULL,
    "found_quantity" DECIMAL(20,6),
    "note" TEXT,

    CONSTRAINT "mock_recall_counts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mock_recalls_organization_id_started_at_idx" ON "mock_recalls"("organization_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mock_recalls_organization_id_id_key" ON "mock_recalls"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "mock_recalls_organization_id_number_key" ON "mock_recalls"("organization_id", "number");

-- CreateIndex
CREATE INDEX "mock_recall_counts_organization_id_mock_recall_id_idx" ON "mock_recall_counts"("organization_id", "mock_recall_id");

-- CreateIndex
CREATE UNIQUE INDEX "mock_recall_counts_organization_id_id_key" ON "mock_recall_counts"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "mock_recalls" ADD CONSTRAINT "mock_recalls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_recalls" ADD CONSTRAINT "mock_recalls_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_recalls" ADD CONSTRAINT "mock_recalls_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_recalls" ADD CONSTRAINT "mock_recalls_organization_id_non_conformance_id_fkey" FOREIGN KEY ("organization_id", "non_conformance_id") REFERENCES "non_conformances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_recall_counts" ADD CONSTRAINT "mock_recall_counts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_recall_counts" ADD CONSTRAINT "mock_recall_counts_organization_id_mock_recall_id_fkey" FOREIGN KEY ("organization_id", "mock_recall_id") REFERENCES "mock_recalls"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_recall_counts" ADD CONSTRAINT "mock_recall_counts_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C2e mock recall exercises (ADR-100): hand-written rules ───
ALTER TABLE "mock_recalls" ADD CONSTRAINT "mock_recalls_ck" CHECK (
  length(btrim("scenario")) > 0
  AND ("target_minutes" IS NULL OR "target_minutes" BETWEEN 1 AND 10080)
  AND "received_quantity" >= 0 AND "exited_quantity" >= 0 AND "gap_count" >= 0 AND "supplier_count" >= 0
  AND ("status" <> 'COMPLETED' OR ("completed_at" IS NOT NULL AND "completed_by_user_id" IS NOT NULL
       AND "elapsed_seconds" IS NOT NULL AND "elapsed_seconds" >= 0 AND "found_quantity" IS NOT NULL))
  AND ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancel_note", ''))) > 0)
  -- Within target only when a target was set.
  AND (("within_target" IS NULL) OR ("target_minutes" IS NOT NULL AND "status" = 'COMPLETED')));
ALTER TABLE "mock_recall_counts" ADD CONSTRAINT "mock_recall_counts_ck" CHECK (
  "book_quantity" >= 0 AND ("found_quantity" IS NULL OR "found_quantity" >= 0));

-- A finished exercise is evidence: frozen once completed or cancelled.
CREATE OR REPLACE FUNCTION mock_recall_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'RUNNING' THEN
    RAISE EXCEPTION 'mock recall % is finished and cannot change', OLD."number";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "mock_recalls_frozen" BEFORE UPDATE ON "mock_recalls"
  FOR EACH ROW EXECUTE FUNCTION mock_recall_frozen();

CREATE OR REPLACE FUNCTION mock_recall_count_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "MockRecallStatus";
BEGIN
  SELECT "status" INTO st FROM "mock_recalls"
    WHERE "organization_id" = OLD."organization_id" AND "id" = OLD."mock_recall_id";
  IF st <> 'RUNNING' THEN
    RAISE EXCEPTION 'mock recall is finished; its counts cannot change';
  END IF;
  IF NEW."book_quantity" <> OLD."book_quantity" OR NEW."warehouse_id" <> OLD."warehouse_id" THEN
    RAISE EXCEPTION 'the book position of a mock recall cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "mock_recall_counts_frozen" BEFORE UPDATE ON "mock_recall_counts"
  FOR EACH ROW EXECUTE FUNCTION mock_recall_count_frozen();

GRANT SELECT, INSERT, UPDATE ON "mock_recalls", "mock_recall_counts" TO fa_tenant;
ALTER TABLE "mock_recalls" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "mock_recalls" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "mock_recall_counts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "mock_recall_counts" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
