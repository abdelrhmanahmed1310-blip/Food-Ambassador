-- CreateEnum
CREATE TYPE "ZatcaDocumentKind" AS ENUM ('SIMPLIFIED', 'STANDARD');

-- CreateEnum
CREATE TYPE "ZatcaUnitPurpose" AS ENUM ('POS', 'OFFICE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ZatcaDocumentStatus" ADD VALUE 'CLEARED';
ALTER TYPE "ZatcaDocumentStatus" ADD VALUE 'CLEARED_WITH_WARNINGS';


-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "building_number" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country_code" CHAR(2) NOT NULL DEFAULT 'SA',
ADD COLUMN     "cr_number" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "postal_code" TEXT,
ADD COLUMN     "street" TEXT;

-- AlterTable
ALTER TABLE "zatca_devices" ADD COLUMN     "purpose" "ZatcaUnitPurpose" NOT NULL DEFAULT 'POS',
ALTER COLUMN "register_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "zatca_documents" ADD COLUMN     "cleared_xml" TEXT,
ADD COLUMN     "kind" "ZatcaDocumentKind" NOT NULL DEFAULT 'SIMPLIFIED',
ADD COLUMN     "sales_invoice_id" UUID;

-- CreateIndex
CREATE INDEX "zatca_documents_organization_id_sales_invoice_id_idx" ON "zatca_documents"("organization_id", "sales_invoice_id");

-- AddForeignKey
ALTER TABLE "zatca_documents" ADD CONSTRAINT "zatca_documents_organization_id_sales_invoice_id_fkey" FOREIGN KEY ("organization_id", "sales_invoice_id") REFERENCES "sales_invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules (ADR-072) ───
-- New enum values are compared as text in this migration.
ALTER TABLE "zatca_documents" DROP CONSTRAINT "zatca_documents_values_ck";
ALTER TABLE "zatca_documents" ADD CONSTRAINT "zatca_documents_values_ck"
  CHECK ("icv" >= 1 AND "attempts" >= 0
     AND (("status"::text IN ('REPORTED', 'REPORTED_WITH_WARNINGS', 'CLEARED', 'CLEARED_WITH_WARNINGS'))
          = ("reported_at" IS NOT NULL))
     AND num_nonnulls("order_id", "refund_id", "sales_invoice_id") <= 1
     AND ("kind" = 'STANDARD' OR "sales_invoice_id" IS NULL)
     AND ("kind" = 'SIMPLIFIED' OR ("order_id" IS NULL AND "refund_id" IS NULL))
     AND ("kind" = 'SIMPLIFIED' OR "status"::text NOT IN ('REPORTED', 'REPORTED_WITH_WARNINGS'))
     AND ("kind" = 'STANDARD' OR "status"::text NOT IN ('CLEARED', 'CLEARED_WITH_WARNINGS'))
     AND (("cleared_xml" IS NOT NULL) = ("status"::text IN ('CLEARED', 'CLEARED_WITH_WARNINGS'))));
-- A signed document never changes; only its reporting or clearance state does (and, once
-- cleared, ZATCA's stamped document and its QR are kept).
DROP TRIGGER "zatca_documents_fixed" ON "zatca_documents";
CREATE TRIGGER "zatca_documents_fixed" BEFORE UPDATE ON "zatca_documents"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('status', 'attempts', 'next_attempt_at', 'response', 'reported_at', 'cleared_xml', 'qr');

ALTER TABLE "zatca_devices" ADD CONSTRAINT "zatca_devices_purpose_ck"
  CHECK (("purpose" = 'POS') = ("register_id" IS NOT NULL));
CREATE UNIQUE INDEX "zatca_devices_one_office" ON "zatca_devices" ("organization_id") WHERE "purpose" = 'OFFICE';

ALTER TABLE "customers" ADD CONSTRAINT "customers_address_ck"
  CHECK ("country_code" ~ '^[A-Z]{2}$'
     AND ("building_number" IS NULL OR "building_number" ~ '^[0-9]{4}$')
     AND ("country_code" <> 'SA' OR "postal_code" IS NULL OR "postal_code" ~ '^[0-9]{5}$'));
