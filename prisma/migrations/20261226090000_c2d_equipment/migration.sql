-- CreateEnum
CREATE TYPE "EquipmentType" AS ENUM ('THERMOMETER', 'FRIDGE', 'FREEZER', 'OVEN', 'HOT_HOLDING', 'SCALE', 'DISHWASHER', 'EXTRACTION', 'OTHER');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('ACTIVE', 'OUT_OF_SERVICE', 'RETIRED');

-- CreateEnum
CREATE TYPE "CalibrationResult" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "MaintenanceType" AS ENUM ('PREVENTIVE', 'REPAIR', 'CLEANING', 'INSPECTION');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'CALIBRATION';

-- AlterEnum
ALTER TYPE "NcSource" ADD VALUE 'EQUIPMENT';

-- DropForeignKey
ALTER TABLE "complaints" DROP CONSTRAINT "complaints_lot_fkey";

-- CreateTable
CREATE TABLE "equipment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EquipmentType" NOT NULL,
    "serial_number" TEXT,
    "location" TEXT,
    "checkpoint_id" UUID,
    "calibration_interval_days" INTEGER,
    "maintenance_interval_days" INTEGER,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_reason" TEXT,
    "status_changed_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calibrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "equipment_id" UUID NOT NULL,
    "performed_on" DATE NOT NULL,
    "performed_by" TEXT NOT NULL,
    "method" TEXT,
    "reference_value" DECIMAL(12,3),
    "reading_value" DECIMAL(12,3),
    "tolerance" DECIMAL(12,3),
    "unit" TEXT,
    "result" "CalibrationResult" NOT NULL,
    "certificate_no" TEXT,
    "next_due_on" DATE,
    "note" TEXT,
    "non_conformance_id" UUID,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calibrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "equipment_id" UUID NOT NULL,
    "type" "MaintenanceType" NOT NULL,
    "performed_on" DATE NOT NULL,
    "performed_by" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "next_due_on" DATE,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "equipment_organization_id_id_key" ON "equipment"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_organization_id_branch_id_code_key" ON "equipment"("organization_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "calibrations_organization_id_equipment_id_performed_on_idx" ON "calibrations"("organization_id", "equipment_id", "performed_on" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "calibrations_organization_id_id_key" ON "calibrations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "maintenance_records_organization_id_equipment_id_performed__idx" ON "maintenance_records"("organization_id", "equipment_id", "performed_on" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_records_organization_id_id_key" ON "maintenance_records"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_organization_id_checkpoint_id_fkey" FOREIGN KEY ("organization_id", "checkpoint_id") REFERENCES "safety_checkpoints"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_organization_id_equipment_id_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_organization_id_non_conformance_id_fkey" FOREIGN KEY ("organization_id", "non_conformance_id") REFERENCES "non_conformances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_organization_id_equipment_id_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ─── C2d equipment, calibration, maintenance (ADR-099): hand-written rules ───

ALTER TABLE "equipment" ADD CONSTRAINT "equipment_ck" CHECK (
  length(btrim("code")) > 0 AND length(btrim("name")) > 0
  AND ("calibration_interval_days" IS NULL OR "calibration_interval_days" BETWEEN 1 AND 3650)
  AND ("maintenance_interval_days" IS NULL OR "maintenance_interval_days" BETWEEN 1 AND 3650)
  AND ("status" = 'ACTIVE' OR (length(btrim(coalesce("status_reason", ''))) > 0 AND "status_changed_at" IS NOT NULL)));
ALTER TABLE "calibrations" ADD CONSTRAINT "calibrations_ck" CHECK (
  length(btrim("performed_by")) > 0
  AND ("tolerance" IS NULL OR "tolerance" >= 0)
  AND (("reference_value" IS NULL) = ("reading_value" IS NULL))
  AND ("reference_value" IS NULL OR "tolerance" IS NOT NULL)
  -- A measured result follows from the numbers.
  AND ("reference_value" IS NULL
       OR ("result" = 'PASS') = (abs("reading_value" - "reference_value") <= "tolerance"))
  AND ("result" = 'PASS' OR "non_conformance_id" IS NOT NULL)
  AND ("next_due_on" IS NULL OR "next_due_on" > "performed_on"));
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_ck" CHECK (
  length(btrim("performed_by")) > 0 AND length(btrim("description")) > 0
  AND ("next_due_on" IS NULL OR "next_due_on" > "performed_on"));

-- Calibration and maintenance records are evidence: never changed or deleted.
GRANT SELECT, INSERT, UPDATE ON "equipment" TO fa_tenant;
GRANT SELECT, INSERT ON "calibrations", "maintenance_records" TO fa_tenant;
ALTER TABLE "equipment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "equipment" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "calibrations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "calibrations" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "maintenance_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "maintenance_records" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
