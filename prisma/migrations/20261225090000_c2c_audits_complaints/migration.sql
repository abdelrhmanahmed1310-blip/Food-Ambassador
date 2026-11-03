-- CreateEnum
CREATE TYPE "AuditType" AS ENUM ('INTERNAL', 'EXTERNAL', 'AUTHORITY', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('PLANNED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('OBSERVATION', 'MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ComplaintChannel" AS ENUM ('IN_PERSON', 'PHONE', 'EMAIL', 'ONLINE', 'DELIVERY_PLATFORM', 'SOCIAL_MEDIA', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplaintCategory" AS ENUM ('FOREIGN_OBJECT', 'ILLNESS', 'ALLERGEN', 'QUALITY', 'TEMPERATURE', 'HYGIENE', 'SERVICE', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.

ALTER TYPE "NcSource" ADD VALUE 'AUDIT';
ALTER TYPE "NcSource" ADD VALUE 'COMPLAINT';

-- CreateTable
CREATE TABLE "audits" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "type" "AuditType" NOT NULL,
    "auditor" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "planned_on" DATE NOT NULL,
    "status" "AuditStatus" NOT NULL DEFAULT 'PLANNED',
    "conducted_on" DATE,
    "result" TEXT,
    "summary" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_findings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "audit_id" UUID NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "non_conformance_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaints" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "channel" "ComplaintChannel" NOT NULL,
    "category" "ComplaintCategory" NOT NULL,
    "customer_name" TEXT,
    "customer_contact" TEXT,
    "order_reference" TEXT,
    "product_id" UUID,
    "lot_id" UUID,
    "description" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "investigation" TEXT,
    "resolution" TEXT,
    "customer_response" TEXT,
    "non_conformance_id" UUID,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audits_organization_id_branch_id_planned_on_idx" ON "audits"("organization_id", "branch_id", "planned_on");

-- CreateIndex
CREATE UNIQUE INDEX "audits_organization_id_id_key" ON "audits"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "audits_organization_id_number_key" ON "audits"("organization_id", "number");

-- CreateIndex
CREATE INDEX "audit_findings_organization_id_audit_id_idx" ON "audit_findings"("organization_id", "audit_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_findings_organization_id_id_key" ON "audit_findings"("organization_id", "id");

-- CreateIndex
CREATE INDEX "complaints_organization_id_branch_id_received_at_idx" ON "complaints"("organization_id", "branch_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "complaints_organization_id_status_idx" ON "complaints"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "complaints_organization_id_id_key" ON "complaints"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "complaints_organization_id_number_key" ON "complaints"("organization_id", "number");

-- AddForeignKey
ALTER TABLE "audits" ADD CONSTRAINT "audits_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audits" ADD CONSTRAINT "audits_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_organization_id_audit_id_fkey" FOREIGN KEY ("organization_id", "audit_id") REFERENCES "audits"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_organization_id_non_conformance_id_fkey" FOREIGN KEY ("organization_id", "non_conformance_id") REFERENCES "non_conformances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_organization_id_non_conformance_id_fkey" FOREIGN KEY ("organization_id", "non_conformance_id") REFERENCES "non_conformances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ─── C2c audits and complaints (ADR-098): hand-written rules ───

ALTER TABLE "audits" ADD CONSTRAINT "audits_ck" CHECK (
  length(btrim("auditor")) > 0 AND length(btrim("scope")) > 0
  AND ("status" = 'COMPLETED') = ("completed_at" IS NOT NULL AND "conducted_on" IS NOT NULL AND "completed_by_user_id" IS NOT NULL)
  AND ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
  AND ("cancelled_at" IS NULL OR length(btrim(coalesce("cancel_reason", ''))) > 0));
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_ck" CHECK (
  length(btrim("description")) > 0
  AND ("severity" = 'OBSERVATION' OR "non_conformance_id" IS NOT NULL));

ALTER TABLE "complaints" ADD CONSTRAINT "complaints_lot_fkey"
  FOREIGN KEY ("organization_id", "product_id", "lot_id")
  REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT;
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_ck" CHECK (
  length(btrim("description")) > 0
  AND ("lot_id" IS NULL OR "product_id" IS NOT NULL)
  AND ("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL
                                  AND length(btrim(coalesce("resolution", ''))) > 0)
  -- Food safety complaints always lead to a non-conformance.
  AND ("category" NOT IN ('FOREIGN_OBJECT', 'ILLNESS', 'ALLERGEN') OR "non_conformance_id" IS NOT NULL));

-- Findings are part of the audit record: added while it is open, never changed.
CREATE FUNCTION audit_finding_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "audits" a WHERE a."organization_id" = NEW."organization_id"
                     AND a."id" = NEW."audit_id" AND a."status" = 'PLANNED') THEN
      RAISE EXCEPTION 'findings are added to an audit before it is completed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."non_conformance_id" IS DISTINCT FROM OLD."non_conformance_id" AND OLD."non_conformance_id" IS NULL
     AND (to_jsonb(NEW) - 'non_conformance_id') = (to_jsonb(OLD) - 'non_conformance_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit findings cannot change' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "audit_findings_fixed" BEFORE INSERT OR UPDATE ON "audit_findings"
  FOR EACH ROW EXECUTE FUNCTION audit_finding_fixed();

-- A completed or cancelled audit is closed.
CREATE FUNCTION audit_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PLANNED' THEN
    RAISE EXCEPTION 'a completed or cancelled audit cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "audits_closed" BEFORE UPDATE ON "audits" FOR EACH ROW EXECUTE FUNCTION audit_closed();

GRANT SELECT, INSERT, UPDATE ON "audits", "audit_findings", "complaints" TO fa_tenant;
ALTER TABLE "audits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audits" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "audit_findings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_findings" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "complaints" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "complaints" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
