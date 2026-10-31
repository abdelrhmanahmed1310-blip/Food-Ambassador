-- CreateEnum
CREATE TYPE "AttachmentScanStatus" AS ENUM ('CLEAN', 'NOT_SCANNED');

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "scan_status" "AttachmentScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
ADD COLUMN     "scanned_at" TIMESTAMPTZ(3);


-- A clean result always records when it was scanned (ADR-055).
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_scan_ck"
  CHECK (("scan_status" = 'CLEAN') = ("scanned_at" IS NOT NULL));
