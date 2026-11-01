-- CreateEnum
CREATE TYPE "ZatcaEnvironment" AS ENUM ('DEVELOPER_PORTAL', 'SIMULATION', 'CORE');

-- CreateEnum
CREATE TYPE "ZatcaDeviceStatus" AS ENUM ('NEW', 'COMPLIANCE', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ZatcaDocumentType" AS ENUM ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE');

-- CreateEnum
CREATE TYPE "ZatcaDocumentStatus" AS ENUM ('PENDING', 'REPORTED', 'REPORTED_WITH_WARNINGS', 'REJECTED');

-- DropIndex

-- CreateTable
CREATE TABLE "zatca_settings" (
    "organization_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "cr_number" TEXT,
    "street" TEXT NOT NULL,
    "building" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "postal_code" TEXT NOT NULL,
    "business_category" TEXT NOT NULL,
    "environment" "ZatcaEnvironment" NOT NULL DEFAULT 'DEVELOPER_PORTAL',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "zatca_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "zatca_devices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "register_id" UUID NOT NULL,
    "environment" "ZatcaEnvironment" NOT NULL,
    "common_name" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "status" "ZatcaDeviceStatus" NOT NULL DEFAULT 'NEW',
    "private_key_sealed" TEXT NOT NULL,
    "csr" TEXT NOT NULL,
    "compliance_request_id" TEXT,
    "compliance_token" TEXT,
    "compliance_secret_sealed" TEXT,
    "production_token" TEXT,
    "production_secret_sealed" TEXT,
    "icv" INTEGER NOT NULL DEFAULT 0,
    "last_hash" TEXT NOT NULL,
    "onboarded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zatca_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zatca_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "type" "ZatcaDocumentType" NOT NULL,
    "order_id" UUID,
    "refund_id" UUID,
    "number" TEXT NOT NULL,
    "uuid" UUID NOT NULL,
    "icv" INTEGER NOT NULL,
    "pih" TEXT NOT NULL,
    "invoice_hash" TEXT NOT NULL,
    "xml" TEXT NOT NULL,
    "qr" TEXT NOT NULL,
    "status" "ZatcaDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response" JSONB,
    "reported_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zatca_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zatca_devices_organization_id_id_key" ON "zatca_devices"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "zatca_devices_organization_id_register_id_key" ON "zatca_devices"("organization_id", "register_id");

-- CreateIndex
CREATE INDEX "zatca_documents_organization_id_order_id_idx" ON "zatca_documents"("organization_id", "order_id");

-- CreateIndex
CREATE INDEX "zatca_documents_status_next_attempt_at_idx" ON "zatca_documents"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "zatca_documents_device_id_icv_key" ON "zatca_documents"("device_id", "icv");

-- AddForeignKey
ALTER TABLE "zatca_settings" ADD CONSTRAINT "zatca_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zatca_devices" ADD CONSTRAINT "zatca_devices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zatca_devices" ADD CONSTRAINT "zatca_devices_organization_id_register_id_fkey" FOREIGN KEY ("organization_id", "register_id") REFERENCES "pos_registers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zatca_documents" ADD CONSTRAINT "zatca_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zatca_documents" ADD CONSTRAINT "zatca_documents_organization_id_device_id_fkey" FOREIGN KEY ("organization_id", "device_id") REFERENCES "zatca_devices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules, access and row-level security (ADR-064) ───

ALTER TABLE "zatca_devices" ADD CONSTRAINT "zatca_devices_values_ck"
  CHECK ("icv" >= 0
     AND ("status" <> 'COMPLIANCE' OR ("compliance_token" IS NOT NULL AND "compliance_secret_sealed" IS NOT NULL))
     AND ("status" <> 'ACTIVE' OR ("production_token" IS NOT NULL AND "production_secret_sealed" IS NOT NULL)));
ALTER TABLE "zatca_documents" ADD CONSTRAINT "zatca_documents_values_ck"
  CHECK ("icv" >= 1 AND "attempts" >= 0
     AND (("status" IN ('REPORTED', 'REPORTED_WITH_WARNINGS')) = ("reported_at" IS NOT NULL))
     AND num_nonnulls("order_id", "refund_id") <= 1);

-- A signed document never changes; only its reporting state does.
CREATE TRIGGER "zatca_documents_fixed" BEFORE UPDATE ON "zatca_documents"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('status', 'attempts', 'next_attempt_at', 'response', 'reported_at');
CREATE FUNCTION "zatca_no_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'e-invoice documents are kept' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER "zatca_documents_no_delete" BEFORE DELETE ON "zatca_documents"
  FOR EACH ROW EXECUTE FUNCTION "zatca_no_delete"();

GRANT SELECT, INSERT, UPDATE ON "zatca_settings", "zatca_devices", "zatca_documents" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zatca_settings', 'zatca_devices', 'zatca_documents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
