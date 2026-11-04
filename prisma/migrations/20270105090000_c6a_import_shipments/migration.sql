-- CreateEnum
CREATE TYPE "ImportShipmentStatus" AS ENUM ('PLANNED', 'IN_TRANSIT', 'ARRIVED', 'CLEARED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransportMode" AS ENUM ('SEA', 'AIR', 'ROAD', 'RAIL', 'COURIER');

-- CreateEnum
CREATE TYPE "Incoterm" AS ENUM ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP');

-- CreateEnum
CREATE TYPE "ContainerType" AS ENUM ('DRY_20', 'DRY_40', 'HIGH_CUBE_40', 'REEFER_20', 'REEFER_40', 'OTHER');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'IMPORT_SHIPMENT';

-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "import_shipment_id" UUID;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "hs_code" TEXT,
ADD COLUMN     "origin_country" CHAR(2);

-- CreateTable
CREATE TABLE "import_shipments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "status" "ImportShipmentStatus" NOT NULL DEFAULT 'PLANNED',
    "mode" "TransportMode" NOT NULL,
    "incoterm" "Incoterm",
    "origin_country" CHAR(2),
    "port_of_loading" TEXT,
    "port_of_discharge" TEXT,
    "carrier" TEXT,
    "transport_document" TEXT,
    "vessel_or_flight" TEXT,
    "etd" DATE,
    "eta" DATE,
    "departed_on" DATE,
    "arrived_on" DATE,
    "cleared_on" DATE,
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "import_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_shipment_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_shipment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_shipment_containers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "type" "ContainerType" NOT NULL,
    "seal_number" TEXT,
    "temperature_c" DECIMAL(5,1),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_shipment_containers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_shipments_organization_id_status_eta_idx" ON "import_shipments"("organization_id", "status", "eta");

-- CreateIndex
CREATE UNIQUE INDEX "import_shipments_organization_id_id_key" ON "import_shipments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "import_shipments_organization_id_number_key" ON "import_shipments"("organization_id", "number");

-- CreateIndex
CREATE INDEX "import_shipment_orders_organization_id_purchase_order_id_idx" ON "import_shipment_orders"("organization_id", "purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_shipment_orders_organization_id_id_key" ON "import_shipment_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "import_shipment_orders_organization_id_shipment_id_purchase_key" ON "import_shipment_orders"("organization_id", "shipment_id", "purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_shipment_containers_organization_id_id_key" ON "import_shipment_containers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "import_shipment_containers_organization_id_shipment_id_numb_key" ON "import_shipment_containers"("organization_id", "shipment_id", "number");

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_import_shipment_id_fkey" FOREIGN KEY ("organization_id", "import_shipment_id") REFERENCES "import_shipments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_orders" ADD CONSTRAINT "import_shipment_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_orders" ADD CONSTRAINT "import_shipment_orders_organization_id_shipment_id_fkey" FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "import_shipments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_orders" ADD CONSTRAINT "import_shipment_orders_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_containers" ADD CONSTRAINT "import_shipment_containers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_containers" ADD CONSTRAINT "import_shipment_containers_organization_id_shipment_id_fkey" FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "import_shipments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── C6a import shipments (ADR-113): hand-written rules ───
ALTER TABLE "products" ADD CONSTRAINT "products_trade_ck" CHECK (
  ("hs_code" IS NULL OR "hs_code" ~ '^[0-9]{6,12}$')
  AND ("origin_country" IS NULL OR "origin_country" ~ '^[A-Z]{2}$'));
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_ck" CHECK (
  ("origin_country" IS NULL OR "origin_country" ~ '^[A-Z]{2}$')
  AND ("etd" IS NULL OR "eta" IS NULL OR "eta" >= "etd")
  AND ("arrived_on" IS NULL OR "departed_on" IS NULL OR "arrived_on" >= "departed_on")
  AND ("cleared_on" IS NULL OR "arrived_on" IS NULL OR "cleared_on" >= "arrived_on")
  AND ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL));
ALTER TABLE "import_shipment_containers" ADD CONSTRAINT "import_shipment_containers_ck" CHECK (
  "number" ~ '^[A-Z]{4}[0-9]{7}$' AND ("temperature_c" IS NULL OR "temperature_c" BETWEEN -60 AND 40));

GRANT SELECT, INSERT, UPDATE ON "import_shipments" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "import_shipment_orders" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "import_shipment_containers" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_shipments', 'import_shipment_orders', 'import_shipment_containers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'trade.view'), ('admin', 'trade.manage'),
             ('procurement', 'trade.view'), ('procurement', 'trade.manage'),
             ('operations_manager', 'trade.view'), ('warehouse', 'trade.view'),
             ('finance', 'trade.view'), ('analyst', 'trade.view'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
