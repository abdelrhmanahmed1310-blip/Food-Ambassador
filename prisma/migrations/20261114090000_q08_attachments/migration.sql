-- CreateEnum
CREATE TYPE "AttachmentEntity" AS ENUM ('PURCHASE_ORDER', 'GOODS_RECEIPT', 'SUPPLIER_INVOICE', 'SUPPLIER_SETTLEMENT', 'STOCK_COUNT');

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" "AttachmentEntity" NOT NULL,
    "entity_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retain_until" DATE NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_user_id" UUID,
    "purged_at" TIMESTAMPTZ(3),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_contents" (
    "attachment_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "attachment_contents_pkey" PRIMARY KEY ("attachment_id")
);

-- CreateIndex
CREATE INDEX "attachments_organization_id_entity_type_entity_id_idx" ON "attachments"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "attachments_retain_until_idx" ON "attachments"("retain_until");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_organization_id_id_key" ON "attachments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_contents_organization_id_attachment_id_key" ON "attachment_contents"("organization_id", "attachment_id");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_contents" ADD CONSTRAINT "attachment_contents_organization_id_attachment_id_fkey" FOREIGN KEY ("organization_id", "attachment_id") REFERENCES "attachments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Rules (ADR-051, Q-08): at most 3 MB, kept 3 years ───

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_values_ck"
  CHECK ("size_bytes" BETWEEN 1 AND 3145728
         AND length("file_name") BETWEEN 1 AND 200
         AND "content_type" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
         AND "sha256" ~ '^[0-9a-f]{64}$'
         AND "retain_until" >= ("uploaded_at" AT TIME ZONE 'UTC')::date
         AND ("removed_at" IS NULL OR "removed_by_user_id" IS NOT NULL));

-- The record is fixed once stored: only removal and purging may be recorded.
CREATE FUNCTION "attachment_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['removed_at', 'removed_by_user_id', 'purged_at'])
     <> (to_jsonb(OLD) - ARRAY['removed_at', 'removed_by_user_id', 'purged_at'])
     OR (OLD."removed_at" IS NOT NULL AND NEW."removed_at" IS DISTINCT FROM OLD."removed_at")
     OR (OLD."purged_at" IS NOT NULL AND NEW."purged_at" IS DISTINCT FROM OLD."purged_at") THEN
    RAISE EXCEPTION 'an attachment can only be removed or purged' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "attachments_fixed" BEFORE UPDATE ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION "attachment_fixed"();

-- The stored bytes must match the recorded size.
CREATE FUNCTION "attachment_content_size"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected int;
BEGIN
  SELECT "size_bytes" INTO expected FROM "attachments"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."attachment_id";
  IF octet_length(NEW."data") <> expected THEN
    RAISE EXCEPTION 'attachment content does not match its size' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "attachment_contents_size" BEFORE INSERT OR UPDATE ON "attachment_contents"
  FOR EACH ROW EXECUTE FUNCTION "attachment_content_size"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "attachments" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "attachment_contents" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attachments', 'attachment_contents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
