-- CreateEnum
CREATE TYPE "PackUnitType" AS ENUM ('CARTON', 'CRATE', 'PALLET', 'BAG', 'OTHER');

-- CreateEnum
CREATE TYPE "LoadStatus" AS ENUM ('OPEN', 'DISPATCHED', 'CANCELLED');

-- AlterTable
ALTER TABLE "pick_lists" ADD COLUMN     "load_id" UUID;

-- CreateTable
CREATE TABLE "pack_units" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "pick_list_id" UUID NOT NULL,
    "type" "PackUnitType" NOT NULL,
    "gross_weight_kg" DECIMAL(12,3),
    "note" TEXT,
    "loaded_at" TIMESTAMPTZ(3),
    "loaded_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pack_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pack_unit_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pack_unit_id" UUID NOT NULL,
    "pick_list_line_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "pack_unit_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "vehicle_ref" TEXT NOT NULL,
    "driver_name" TEXT,
    "planned_departure_at" TIMESTAMPTZ(3),
    "status" "LoadStatus" NOT NULL DEFAULT 'OPEN',
    "vehicle_temperature_celsius" DECIMAL(5,1),
    "seal_number" TEXT,
    "note" TEXT,
    "dispatched_at" TIMESTAMPTZ(3),
    "dispatched_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pack_units_organization_id_pick_list_id_idx" ON "pack_units"("organization_id", "pick_list_id");

-- CreateIndex
CREATE UNIQUE INDEX "pack_units_organization_id_id_key" ON "pack_units"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pack_units_organization_id_number_key" ON "pack_units"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "pack_unit_lines_organization_id_id_key" ON "pack_unit_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pack_unit_lines_organization_id_pack_unit_id_pick_list_line_key" ON "pack_unit_lines"("organization_id", "pack_unit_id", "pick_list_line_id");

-- CreateIndex
CREATE INDEX "loads_organization_id_warehouse_id_status_idx" ON "loads"("organization_id", "warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "loads_organization_id_id_key" ON "loads"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "loads_organization_id_number_key" ON "loads"("organization_id", "number");

-- AddForeignKey
ALTER TABLE "pick_lists" ADD CONSTRAINT "pick_lists_organization_id_load_id_fkey" FOREIGN KEY ("organization_id", "load_id") REFERENCES "loads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_units" ADD CONSTRAINT "pack_units_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_units" ADD CONSTRAINT "pack_units_organization_id_pick_list_id_fkey" FOREIGN KEY ("organization_id", "pick_list_id") REFERENCES "pick_lists"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_unit_lines" ADD CONSTRAINT "pack_unit_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_unit_lines" ADD CONSTRAINT "pack_unit_lines_organization_id_pack_unit_id_fkey" FOREIGN KEY ("organization_id", "pack_unit_id") REFERENCES "pack_units"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pack_unit_lines" ADD CONSTRAINT "pack_unit_lines_organization_id_pick_list_line_id_fkey" FOREIGN KEY ("organization_id", "pick_list_line_id") REFERENCES "pick_list_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loads" ADD CONSTRAINT "loads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loads" ADD CONSTRAINT "loads_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C3c packing and loading (ADR-103): hand-written rules ───
ALTER TABLE "pack_units" ADD CONSTRAINT "pack_units_ck" CHECK (
  ("gross_weight_kg" IS NULL OR "gross_weight_kg" > 0)
  AND (("loaded_at" IS NULL) = ("loaded_by_user_id" IS NULL)));
ALTER TABLE "pack_unit_lines" ADD CONSTRAINT "pack_unit_lines_ck" CHECK ("quantity" > 0);
ALTER TABLE "loads" ADD CONSTRAINT "loads_ck" CHECK (
  length(btrim("vehicle_ref")) > 0
  AND ("status" <> 'DISPATCHED' OR ("dispatched_at" IS NOT NULL AND "dispatched_by_user_id" IS NOT NULL))
  AND ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND length(btrim(coalesce("cancel_reason", ''))) > 0)));

-- Units of a delivered list are evidence; unloaded units of a picked list may be repacked.
CREATE OR REPLACE FUNCTION pack_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "PickListStatus";
BEGIN
  SELECT "status" INTO st FROM "pick_lists"
    WHERE "organization_id" = OLD."organization_id" AND "id" = OLD."pick_list_id";
  IF st <> 'PICKED' AND NOT (TG_OP = 'DELETE' AND st = 'CANCELLED') THEN
    RAISE EXCEPTION 'pack units of a delivered list cannot change';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."pick_list_id" <> OLD."pick_list_id" THEN
    RAISE EXCEPTION 'a pack unit cannot move to another pick list';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pack_units_guard" BEFORE UPDATE OR DELETE ON "pack_units"
  FOR EACH ROW EXECUTE FUNCTION pack_unit_guard();

CREATE OR REPLACE FUNCTION load_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'load % is finished and cannot change', OLD."number";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "loads_guard" BEFORE UPDATE ON "loads"
  FOR EACH ROW EXECUTE FUNCTION load_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON "pack_units" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "pack_unit_lines" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "loads" TO fa_tenant;
ALTER TABLE "pack_units" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pack_units" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "pack_unit_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pack_unit_lines" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "loads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "loads" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
