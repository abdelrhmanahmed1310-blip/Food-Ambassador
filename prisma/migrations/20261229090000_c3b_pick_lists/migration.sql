-- CreateEnum
CREATE TYPE "PickListStatus" AS ENUM ('PLANNED', 'PICKED', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "pick_waves" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pick_waves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_lists" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "wave_id" UUID,
    "status" "PickListStatus" NOT NULL DEFAULT 'PLANNED',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "picked_at" TIMESTAMPTZ(3),
    "picked_by_user_id" UUID,
    "pick_document_id" UUID,
    "return_document_id" UUID,
    "delivery_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pick_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_list_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pick_list_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "order_line_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID,
    "location_id" UUID,
    "staging_location_id" UUID NOT NULL,
    "planned_quantity" DECIMAL(20,6) NOT NULL,
    "picked_quantity" DECIMAL(20,6),
    "short_reason" TEXT,

    CONSTRAINT "pick_list_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pick_waves_organization_id_warehouse_id_created_at_idx" ON "pick_waves"("organization_id", "warehouse_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pick_waves_organization_id_id_key" ON "pick_waves"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pick_waves_organization_id_number_key" ON "pick_waves"("organization_id", "number");

-- CreateIndex
CREATE INDEX "pick_lists_organization_id_warehouse_id_status_idx" ON "pick_lists"("organization_id", "warehouse_id", "status");

-- CreateIndex
CREATE INDEX "pick_lists_organization_id_sales_order_id_idx" ON "pick_lists"("organization_id", "sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "pick_lists_organization_id_id_key" ON "pick_lists"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pick_lists_organization_id_number_key" ON "pick_lists"("organization_id", "number");

-- CreateIndex
CREATE INDEX "pick_list_lines_organization_id_location_id_lot_id_idx" ON "pick_list_lines"("organization_id", "location_id", "lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "pick_list_lines_organization_id_id_key" ON "pick_list_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pick_list_lines_organization_id_pick_list_id_sequence_key" ON "pick_list_lines"("organization_id", "pick_list_id", "sequence");

-- AddForeignKey
ALTER TABLE "pick_waves" ADD CONSTRAINT "pick_waves_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_waves" ADD CONSTRAINT "pick_waves_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_organization_id_sales_order_id_fkey" FOREIGN KEY ("organization_id", "sales_order_id") REFERENCES "sales_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_organization_id_wave_id_fkey" FOREIGN KEY ("organization_id", "wave_id") REFERENCES "pick_waves"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_organization_id_pick_document_id_fkey" FOREIGN KEY ("organization_id", "pick_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_organization_id_return_document_id_fkey" FOREIGN KEY ("organization_id", "return_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_organization_id_delivery_id_fkey" FOREIGN KEY ("organization_id", "delivery_id") REFERENCES "customer_deliveries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_lines" ADD CONSTRAINT "pick_list_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_lines" ADD CONSTRAINT "pick_list_lines_organization_id_pick_list_id_fkey" FOREIGN KEY ("organization_id", "pick_list_id") REFERENCES "pick_lists"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_lines" ADD CONSTRAINT "pick_list_lines_organization_id_order_line_id_fkey" FOREIGN KEY ("organization_id", "order_line_id") REFERENCES "sales_order_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_lines" ADD CONSTRAINT "pick_list_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_lines" ADD CONSTRAINT "pick_list_lines_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_lines" ADD CONSTRAINT "pick_list_lines_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "storage_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pick_list_lines" ADD CONSTRAINT "pick_list_lines_organization_id_staging_location_id_fkey" FOREIGN KEY ("organization_id", "staging_location_id") REFERENCES "storage_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C3b pick lists and waves (ADR-102): hand-written rules ───
ALTER TABLE "pick_list_lines" ADD CONSTRAINT "pick_list_lines_ck" CHECK (
  "planned_quantity" > 0
  AND ("picked_quantity" IS NULL OR ("picked_quantity" >= 0 AND "picked_quantity" <= "planned_quantity"))
  AND ("picked_quantity" IS NULL OR "picked_quantity" = "planned_quantity"
       OR length(btrim(coalesce("short_reason", ''))) > 0));
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_ck" CHECK (
  ("status" = 'PLANNED' OR "status" = 'CANCELLED' OR ("picked_at" IS NOT NULL AND "picked_by_user_id" IS NOT NULL))
  AND ("status" <> 'DELIVERED' OR "delivery_id" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND length(btrim(coalesce("cancel_reason", ''))) > 0)));

-- Lines are fixed once the list leaves PLANNED; finished lists are frozen.
CREATE OR REPLACE FUNCTION pick_list_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "PickListStatus";
BEGIN
  SELECT "status" INTO st FROM "pick_lists"
    WHERE "organization_id" = OLD."organization_id" AND "id" = OLD."pick_list_id";
  IF st <> 'PLANNED' THEN
    RAISE EXCEPTION 'pick list lines cannot change once picked or cancelled';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."planned_quantity" <> OLD."planned_quantity" OR NEW."product_id" <> OLD."product_id"
     OR NEW."lot_id" IS DISTINCT FROM OLD."lot_id" OR NEW."location_id" IS DISTINCT FROM OLD."location_id" THEN
    RAISE EXCEPTION 'the plan of a pick list line cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pick_list_lines_guard" BEFORE UPDATE OR DELETE ON "pick_list_lines"
  FOR EACH ROW EXECUTE FUNCTION pick_list_line_guard();

CREATE OR REPLACE FUNCTION pick_list_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('DELIVERED', 'CANCELLED') THEN
    RAISE EXCEPTION 'pick list % is finished and cannot change', OLD."number";
  END IF;
  IF OLD."status" = 'PICKED' AND NEW."status" NOT IN ('PICKED', 'DELIVERED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a picked list can only be delivered or cancelled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pick_lists_guard" BEFORE UPDATE ON "pick_lists"
  FOR EACH ROW EXECUTE FUNCTION pick_list_guard();

GRANT SELECT, INSERT ON "pick_waves" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "pick_lists", "pick_list_lines" TO fa_tenant;
ALTER TABLE "pick_waves" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pick_waves" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "pick_lists" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pick_lists" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "pick_list_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pick_list_lines" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
