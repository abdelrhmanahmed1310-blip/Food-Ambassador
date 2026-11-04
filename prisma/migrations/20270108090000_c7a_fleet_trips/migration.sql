-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('VAN', 'TRUCK', 'CAR', 'MOTORBIKE', 'OTHER');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TripStopKind" AS ENUM ('CUSTOMER_DELIVERY', 'TRANSFER');

-- CreateEnum
CREATE TYPE "TripStopStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'TRIP_STOP';

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "plate_number" TEXT NOT NULL,
    "type" "VehicleType" NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "refrigerated" BOOLEAN NOT NULL DEFAULT false,
    "min_temperature_c" DECIMAL(5,1),
    "max_temperature_c" DECIMAL(5,1),
    "capacity_kg" DECIMAL(10,1),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "driver_user_id" UUID NOT NULL,
    "planned_on" DATE NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'PLANNED',
    "start_odometer_km" INTEGER,
    "end_odometer_km" INTEGER,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_stops" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "TripStopKind" NOT NULL,
    "customer_delivery_id" UUID,
    "stock_shipment_id" UUID,
    "status" "TripStopStatus" NOT NULL DEFAULT 'PENDING',
    "arrived_at" TIMESTAMPTZ(3),
    "recipient_name" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    "handover_temperature_c" DECIMAL(5,1),
    "signature_svg" TEXT,
    "failure_reason" TEXT,
    "note" TEXT,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temperature_readings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "temperature_c" DECIMAL(5,1) NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL,
    "excursion" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temperature_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_organization_id_id_key" ON "vehicles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_organization_id_code_key" ON "vehicles"("organization_id", "code");

-- CreateIndex
CREATE INDEX "trips_organization_id_warehouse_id_planned_on_idx" ON "trips"("organization_id", "warehouse_id", "planned_on");

-- CreateIndex
CREATE INDEX "trips_organization_id_driver_user_id_status_idx" ON "trips"("organization_id", "driver_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trips_organization_id_id_key" ON "trips"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trips_organization_id_number_key" ON "trips"("organization_id", "number");

-- CreateIndex
CREATE INDEX "trip_stops_organization_id_customer_delivery_id_idx" ON "trip_stops"("organization_id", "customer_delivery_id");

-- CreateIndex
CREATE INDEX "trip_stops_organization_id_stock_shipment_id_idx" ON "trip_stops"("organization_id", "stock_shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_stops_organization_id_id_key" ON "trip_stops"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trip_stops_organization_id_trip_id_sequence_key" ON "trip_stops"("organization_id", "trip_id", "sequence");

-- CreateIndex
CREATE INDEX "temperature_readings_organization_id_trip_id_read_at_idx" ON "temperature_readings"("organization_id", "trip_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "temperature_readings_organization_id_id_key" ON "temperature_readings"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_organization_id_vehicle_id_fkey" FOREIGN KEY ("organization_id", "vehicle_id") REFERENCES "vehicles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_user_id_fkey" FOREIGN KEY ("driver_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_organization_id_trip_id_fkey" FOREIGN KEY ("organization_id", "trip_id") REFERENCES "trips"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_organization_id_customer_delivery_id_fkey" FOREIGN KEY ("organization_id", "customer_delivery_id") REFERENCES "customer_deliveries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_organization_id_stock_shipment_id_fkey" FOREIGN KEY ("organization_id", "stock_shipment_id") REFERENCES "stock_shipments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_organization_id_trip_id_fkey" FOREIGN KEY ("organization_id", "trip_id") REFERENCES "trips"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C7a own fleet (ADR-116): hand-written rules ───
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_ck" CHECK (
  ("refrigerated" AND "min_temperature_c" IS NOT NULL AND "max_temperature_c" IS NOT NULL
     AND "min_temperature_c" <= "max_temperature_c")
  OR (NOT "refrigerated" AND "min_temperature_c" IS NULL AND "max_temperature_c" IS NULL));
ALTER TABLE "trips" ADD CONSTRAINT "trips_ck" CHECK (
  ("start_odometer_km" IS NULL OR "start_odometer_km" >= 0)
  AND ("end_odometer_km" IS NULL OR "start_odometer_km" IS NULL OR "end_odometer_km" >= "start_odometer_km")
  AND ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL));
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_ck" CHECK (
  ("kind" = 'CUSTOMER_DELIVERY' AND "customer_delivery_id" IS NOT NULL AND "stock_shipment_id" IS NULL)
  OR ("kind" = 'TRANSFER' AND "stock_shipment_id" IS NOT NULL AND "customer_delivery_id" IS NULL))
  , ADD CONSTRAINT "trip_stops_pod_ck" CHECK (
  ("status" <> 'DELIVERED' OR ("recipient_name" IS NOT NULL AND "delivered_at" IS NOT NULL))
  AND ("status" <> 'FAILED' OR "failure_reason" IS NOT NULL)
  AND ("signature_svg" IS NULL OR length("signature_svg") <= 20000));
-- A consignment is on one open (pending or delivered) stop at a time.
CREATE UNIQUE INDEX "trip_stops_delivery_open" ON "trip_stops"("organization_id", "customer_delivery_id")
  WHERE "customer_delivery_id" IS NOT NULL AND "status" <> 'FAILED';
CREATE UNIQUE INDEX "trip_stops_shipment_open" ON "trip_stops"("organization_id", "stock_shipment_id")
  WHERE "stock_shipment_id" IS NOT NULL AND "status" <> 'FAILED';
ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_ck" CHECK ("temperature_c" BETWEEN -60 AND 60);

-- A proof of delivery is final once recorded.
CREATE OR REPLACE FUNCTION "trip_stop_pod_final"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'a recorded proof of delivery cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "trip_stops_pod_final" BEFORE UPDATE ON "trip_stops"
  FOR EACH ROW EXECUTE FUNCTION "trip_stop_pod_final"();

GRANT SELECT, INSERT, UPDATE ON "vehicles", "trips" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "trip_stops" TO fa_tenant;
GRANT SELECT, INSERT ON "temperature_readings" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicles', 'trips', 'trip_stops', 'temperature_readings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

-- The Driver system role for existing organizations; mirrors SYSTEM_ROLE_TEMPLATES.
INSERT INTO "roles" ("id", "organization_id", "key", "name", "description", "is_system", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", 'driver', 'Driver',
       'Drives delivery trips: records arrivals, proof of delivery and temperatures on their own trips (usually granted at warehouse scope).', true, now(), now()
FROM "organizations" o
ON CONFLICT ("organization_id", "key") DO NOTHING;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'logistics.view'), ('admin', 'logistics.manage'), ('admin', 'logistics.deliver'),
  ('operations_manager', 'logistics.view'), ('operations_manager', 'logistics.manage'), ('operations_manager', 'logistics.deliver'),
  ('warehouse', 'logistics.view'), ('warehouse', 'logistics.manage'), ('warehouse', 'logistics.deliver'),
  ('branch_manager', 'logistics.view'), ('analyst', 'logistics.view'), ('food_safety', 'logistics.view'),
  ('driver', 'logistics.view'), ('driver', 'logistics.deliver')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
