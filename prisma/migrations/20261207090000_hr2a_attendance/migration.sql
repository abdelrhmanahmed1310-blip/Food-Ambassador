-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('TERMINAL', 'PHONE', 'DEVICE', 'MANUAL');

-- CreateEnum
CREATE TYPE "PunchKind" AS ENUM ('IN', 'OUT');

-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'ATTENDANCE_DEVICE';


-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "pin_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pin_hash" TEXT,
ADD COLUMN     "pin_locked_until" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "attendance_terminals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "public_token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_terminals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_geofences" (
    "branch_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "radius_meters" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_geofences_pkey" PRIMARY KEY ("branch_id")
);

-- CreateTable
CREATE TABLE "attendance_punches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" "PunchKind" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "source" "AttendanceSource" NOT NULL,
    "terminal_id" UUID,
    "connector_id" UUID,
    "external_id" TEXT,
    "distance_meters" INTEGER,
    "recorded_by_user_id" UUID,
    "reason" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_punches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_terminals_public_token_key" ON "attendance_terminals"("public_token");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_terminals_organization_id_id_key" ON "attendance_terminals"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_geofences_organization_id_branch_id_key" ON "branch_geofences"("organization_id", "branch_id");

-- CreateIndex
CREATE INDEX "attendance_punches_organization_id_employee_id_at_idx" ON "attendance_punches"("organization_id", "employee_id", "at");

-- CreateIndex
CREATE INDEX "attendance_punches_organization_id_branch_id_at_idx" ON "attendance_punches"("organization_id", "branch_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_punches_connector_id_external_id_key" ON "attendance_punches"("connector_id", "external_id");

-- AddForeignKey
ALTER TABLE "attendance_terminals" ADD CONSTRAINT "attendance_terminals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_terminals" ADD CONSTRAINT "attendance_terminals_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_geofences" ADD CONSTRAINT "branch_geofences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_geofences" ADD CONSTRAINT "branch_geofences_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_organization_id_terminal_id_fkey" FOREIGN KEY ("organization_id", "terminal_id") REFERENCES "attendance_terminals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_organization_id_connector_id_fkey" FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (ADR-080) --------------------------------------------------------
-- New enum values are compared as text in this migration.

ALTER TABLE "attendance_terminals" ADD CONSTRAINT "attendance_terminals_values_ck"
  CHECK (length("name") BETWEEN 1 AND 80 AND length("public_token") BETWEEN 24 AND 64);

ALTER TABLE "branch_geofences" ADD CONSTRAINT "branch_geofences_values_ck"
  CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180
    AND "radius_meters" BETWEEN 20 AND 5000);

ALTER TABLE "employees" ADD CONSTRAINT "employees_pin_ck" CHECK ("pin_failures" >= 0);

ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_values_ck"
  CHECK (("source"::text = 'TERMINAL') = ("terminal_id" IS NOT NULL)
    AND ("source"::text = 'DEVICE') = ("connector_id" IS NOT NULL)
    AND ("source"::text <> 'DEVICE' OR "external_id" IS NOT NULL)
    AND ("source"::text <> 'MANUAL' OR ("reason" IS NOT NULL AND "recorded_by_user_id" IS NOT NULL))
    AND ("distance_meters" IS NULL OR "distance_meters" >= 0)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    AND ("voided_at" IS NULL) = ("voided_by_user_id" IS NULL));

-- A punch is never edited, only voided (with who and why).
CREATE TRIGGER "attendance_punches_fixed" BEFORE UPDATE ON "attendance_punches"
  FOR EACH ROW EXECUTE FUNCTION pos_fixed_except('voided_at', 'voided_by_user_id', 'void_reason');

GRANT SELECT, INSERT, UPDATE ON "attendance_terminals" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "branch_geofences" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "attendance_punches" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_terminals', 'branch_geofences', 'attendance_punches']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
