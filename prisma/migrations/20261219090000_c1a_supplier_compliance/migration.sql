-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SupplierDocumentType" AS ENUM ('COMMERCIAL_REGISTRATION', 'VAT_CERTIFICATE', 'MUNICIPALITY_LICENSE', 'FOOD_SAFETY_CERTIFICATE', 'HALAL_CERTIFICATE', 'ISO_CERTIFICATE', 'INSURANCE', 'CONTRACT', 'OTHER');

-- CreateEnum
CREATE TYPE "SupplierBankAccountKind" AS ENUM ('IBAN', 'ACCOUNT_NUMBER');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'SUPPLIER_DOCUMENT';

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable
ALTER TABLE "procurement_settings" ADD COLUMN     "supplier_approval_required" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "approved_at" TIMESTAMPTZ(3),
ADD COLUMN     "approved_by_user_id" UUID,
ADD COLUMN     "blocked_at" TIMESTAMPTZ(3),
ADD COLUMN     "blocked_by_user_id" UUID,
ADD COLUMN     "blocked_reason" TEXT,
ADD COLUMN     "created_by_user_id" UUID,
ADD COLUMN     "status" "SupplierStatus" NOT NULL DEFAULT 'APPROVED';

-- AlterTable

-- CreateTable
CREATE TABLE "supplier_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "type" "SupplierDocumentType" NOT NULL,
    "title" TEXT,
    "number" TEXT,
    "issued_on" DATE,
    "expires_on" DATE,
    "required_to_buy" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_user_id" UUID,

    CONSTRAINT "supplier_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bank_accounts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "kind" "SupplierBankAccountKind" NOT NULL,
    "account_sealed" TEXT NOT NULL,
    "account_last4" TEXT NOT NULL,
    "swift_bic" TEXT,
    "currency" CHAR(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_user_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_user_id" UUID,

    CONSTRAINT "supplier_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_documents_organization_id_supplier_id_idx" ON "supplier_documents"("organization_id", "supplier_id");

-- CreateIndex
CREATE INDEX "supplier_documents_organization_id_expires_on_idx" ON "supplier_documents"("organization_id", "expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_documents_organization_id_id_key" ON "supplier_documents"("organization_id", "id");

-- CreateIndex
CREATE INDEX "supplier_bank_accounts_organization_id_supplier_id_idx" ON "supplier_bank_accounts"("organization_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bank_accounts_organization_id_id_key" ON "supplier_bank_accounts"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bank_accounts" ADD CONSTRAINT "supplier_bank_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bank_accounts" ADD CONSTRAINT "supplier_bank_accounts_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── C1a supplier compliance (ADR-091): hand-written rules ───

-- A blocked supplier always carries who, when and why.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_blocked_complete"
  CHECK (("status" = 'BLOCKED') = ("blocked_at" IS NOT NULL)
     AND ("blocked_at" IS NULL) = ("blocked_by_user_id" IS NULL)
     AND ("blocked_at" IS NULL OR length(btrim("blocked_reason")) > 0));
-- Approval is a second person's decision.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_approved_complete"
  CHECK (("approved_at" IS NULL) = ("approved_by_user_id" IS NULL)
     AND ("approved_by_user_id" IS NULL OR "created_by_user_id" IS NULL
          OR "approved_by_user_id" <> "created_by_user_id"));

ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_title"
  CHECK ("type" <> 'OTHER' OR length(btrim(coalesce("title", ''))) > 0);
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_dates"
  CHECK ("issued_on" IS NULL OR "expires_on" IS NULL OR "expires_on" >= "issued_on");
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_archived"
  CHECK (("archived_at" IS NULL) = ("archived_by_user_id" IS NULL));

ALTER TABLE "supplier_bank_accounts" ADD CONSTRAINT "supplier_bank_accounts_last4"
  CHECK (length("account_last4") BETWEEN 1 AND 4);
ALTER TABLE "supplier_bank_accounts" ADD CONSTRAINT "supplier_bank_accounts_verified"
  CHECK (("verified_at" IS NULL) = ("verified_by_user_id" IS NULL)
     AND ("verified_by_user_id" IS NULL OR "verified_by_user_id" <> "created_by_user_id"));
ALTER TABLE "supplier_bank_accounts" ADD CONSTRAINT "supplier_bank_accounts_archived"
  CHECK (("archived_at" IS NULL) = ("archived_by_user_id" IS NULL));

-- The account itself never changes: a new account is added instead, so a
-- verification always refers to the number that was checked. Verification
-- and archiving happen once.
CREATE FUNCTION supplier_bank_account_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."supplier_id" <> OLD."supplier_id" OR NEW."kind" <> OLD."kind"
     OR NEW."account_sealed" <> OLD."account_sealed" OR NEW."account_last4" <> OLD."account_last4"
     OR NEW."swift_bic" IS DISTINCT FROM OLD."swift_bic"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."bank_name" <> OLD."bank_name" OR NEW."account_name" <> OLD."account_name"
     OR NEW."created_by_user_id" <> OLD."created_by_user_id" OR NEW."created_at" <> OLD."created_at"
  THEN
    RAISE EXCEPTION 'supplier bank account details cannot change; add a new account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."verified_at" IS NOT NULL AND NEW."verified_at" IS DISTINCT FROM OLD."verified_at")
     OR (OLD."archived_at" IS NOT NULL AND NEW."archived_at" IS DISTINCT FROM OLD."archived_at")
  THEN
    RAISE EXCEPTION 'supplier bank account verification and archiving are final'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_bank_accounts_fixed" BEFORE UPDATE ON "supplier_bank_accounts"
  FOR EACH ROW EXECUTE FUNCTION supplier_bank_account_fixed();

GRANT SELECT, INSERT, UPDATE ON "supplier_documents" TO fa_tenant;
ALTER TABLE "supplier_documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_documents" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

GRANT SELECT, INSERT, UPDATE ON "supplier_bank_accounts" TO fa_tenant;
ALTER TABLE "supplier_bank_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "supplier_bank_accounts" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

-- Existing organizations' system roles get the new permissions (as new ones do).
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'suppliers.approve'), ('admin', 'suppliers.bank.manage'),
             ('finance', 'suppliers.approve'), ('finance', 'suppliers.bank.manage'),
             ('procurement', 'suppliers.bank.manage'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
