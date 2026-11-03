-- CreateEnum
CREATE TYPE "FsDocumentType" AS ENUM ('POLICY', 'SOP', 'WORK_INSTRUCTION', 'FORM', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "FsDocumentStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'FS_DOCUMENT_VERSION';

-- CreateTable
CREATE TABLE "fs_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "FsDocumentType" NOT NULL,
    "branch_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawn_by_user_id" UUID,
    "withdraw_reason" TEXT,

    CONSTRAINT "fs_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fs_document_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "FsDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "content" TEXT NOT NULL,
    "change_summary" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "approved_at" TIMESTAMPTZ(3),
    "approved_by_user_id" UUID,
    "effective_from" DATE,
    "review_due_on" DATE,
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "fs_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fs_document_reads" (
    "organization_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fs_document_reads_pkey" PRIMARY KEY ("organization_id","version_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fs_documents_organization_id_id_key" ON "fs_documents"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fs_documents_organization_id_code_key" ON "fs_documents"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "fs_document_versions_organization_id_id_key" ON "fs_document_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fs_document_versions_organization_id_document_id_version_key" ON "fs_document_versions"("organization_id", "document_id", "version");

-- AddForeignKey
ALTER TABLE "fs_documents" ADD CONSTRAINT "fs_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fs_documents" ADD CONSTRAINT "fs_documents_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fs_document_versions" ADD CONSTRAINT "fs_document_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fs_document_versions" ADD CONSTRAINT "fs_document_versions_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "fs_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fs_document_reads" ADD CONSTRAINT "fs_document_reads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fs_document_reads" ADD CONSTRAINT "fs_document_reads_organization_id_version_id_fkey" FOREIGN KEY ("organization_id", "version_id") REFERENCES "fs_document_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ─── C2b document control (ADR-097): hand-written rules ───

ALTER TABLE "fs_documents" ADD CONSTRAINT "fs_documents_ck"
  CHECK (length(btrim("code")) > 0 AND length(btrim("title")) > 0
     AND ("withdrawn_at" IS NULL) = ("withdrawn_by_user_id" IS NULL)
     AND ("withdrawn_at" IS NULL OR length(btrim(coalesce("withdraw_reason", ''))) > 0));
ALTER TABLE "fs_document_versions" ADD CONSTRAINT "fs_document_versions_ck" CHECK (
  "version" >= 1 AND length(btrim("content")) > 0
  AND ("status" = 'DRAFT') = ("approved_at" IS NULL)
  AND ("approved_at" IS NULL) = ("approved_by_user_id" IS NULL)
  AND ("approved_at" IS NULL) = ("effective_from" IS NULL)
  AND ("approved_by_user_id" IS NULL OR "approved_by_user_id" <> "created_by_user_id")
  AND ("status" = 'SUPERSEDED') = ("superseded_at" IS NOT NULL)
  AND ("review_due_on" IS NULL OR "effective_from" IS NULL OR "review_due_on" > "effective_from"));
CREATE UNIQUE INDEX "fs_document_versions_one_approved" ON "fs_document_versions" ("organization_id", "document_id") WHERE "status" = 'APPROVED';
CREATE UNIQUE INDEX "fs_document_versions_one_draft" ON "fs_document_versions" ("organization_id", "document_id") WHERE "status" = 'DRAFT';

-- An approved version is the record of what was in force: it never changes,
-- except to be superseded by the next approved version.
CREATE FUNCTION fs_document_version_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED'
     AND (to_jsonb(NEW) - 'status' - 'superseded_at' - 'updated_at')
       = (to_jsonb(OLD) - 'status' - 'superseded_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an approved document version cannot change; start a new version'
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "fs_document_versions_fixed" BEFORE UPDATE ON "fs_document_versions"
  FOR EACH ROW EXECUTE FUNCTION fs_document_version_fixed();

-- Reads are confirmed only for approved (or since superseded) versions.
CREATE FUNCTION fs_document_read_approved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "fs_document_versions" v
                 WHERE v."organization_id" = NEW."organization_id" AND v."id" = NEW."version_id"
                   AND v."status" <> 'DRAFT') THEN
    RAISE EXCEPTION 'only an approved version can be confirmed as read' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "fs_document_reads_approved" BEFORE INSERT ON "fs_document_reads"
  FOR EACH ROW EXECUTE FUNCTION fs_document_read_approved();

GRANT SELECT, INSERT, UPDATE ON "fs_documents", "fs_document_versions" TO fa_tenant;
GRANT SELECT, INSERT ON "fs_document_reads" TO fa_tenant;
ALTER TABLE "fs_documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fs_documents" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "fs_document_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fs_document_versions" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "fs_document_reads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "fs_document_reads" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
