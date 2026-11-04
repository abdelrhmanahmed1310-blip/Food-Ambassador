-- CreateEnum
CREATE TYPE "TradeDocumentScope" AS ENUM ('SHIPMENT', 'PRODUCT');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'TRADE_DOCUMENT';

-- CreateTable
CREATE TABLE "trade_document_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "scope" "TradeDocumentScope" NOT NULL,
    "has_expiry" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_document_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_requirements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "destination_country" CHAR(2),
    "origin_country" CHAR(2),
    "hs_prefix" TEXT,
    "authority" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "trade_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "shipment_id" UUID,
    "product_id" UUID,
    "number" TEXT,
    "issued_by" TEXT,
    "issued_on" DATE,
    "expires_on" DATE,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_user_id" UUID,
    "archive_reason" TEXT,

    CONSTRAINT "trade_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_document_types_organization_id_id_key" ON "trade_document_types"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trade_document_types_organization_id_code_key" ON "trade_document_types"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "trade_requirements_organization_id_id_key" ON "trade_requirements"("organization_id", "id");

-- CreateIndex
CREATE INDEX "trade_documents_organization_id_shipment_id_idx" ON "trade_documents"("organization_id", "shipment_id");

-- CreateIndex
CREATE INDEX "trade_documents_organization_id_product_id_idx" ON "trade_documents"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "trade_documents_organization_id_expires_on_idx" ON "trade_documents"("organization_id", "expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "trade_documents_organization_id_id_key" ON "trade_documents"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "trade_document_types" ADD CONSTRAINT "trade_document_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_requirements" ADD CONSTRAINT "trade_requirements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_requirements" ADD CONSTRAINT "trade_requirements_organization_id_document_type_id_fkey" FOREIGN KEY ("organization_id", "document_type_id") REFERENCES "trade_document_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_organization_id_document_type_id_fkey" FOREIGN KEY ("organization_id", "document_type_id") REFERENCES "trade_document_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_organization_id_shipment_id_fkey" FOREIGN KEY ("organization_id", "shipment_id") REFERENCES "import_shipments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C6b trade documents (ADR-114): hand-written rules ───
ALTER TABLE "trade_requirements" ADD CONSTRAINT "trade_requirements_ck" CHECK (
  ("destination_country" IS NULL OR "destination_country" ~ '^[A-Z]{2}$')
  AND ("origin_country" IS NULL OR "origin_country" ~ '^[A-Z]{2}$')
  AND ("hs_prefix" IS NULL OR "hs_prefix" ~ '^[0-9]{2,12}$'));
ALTER TABLE "trade_documents" ADD CONSTRAINT "trade_documents_ck" CHECK (
  (("shipment_id" IS NULL) <> ("product_id" IS NULL))
  AND ("expires_on" IS NULL OR "issued_on" IS NULL OR "expires_on" >= "issued_on")
  AND ("archived_at" IS NULL OR "archive_reason" IS NOT NULL));

GRANT SELECT, INSERT, UPDATE ON "trade_document_types", "trade_requirements", "trade_documents" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trade_document_types', 'trade_requirements', 'trade_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;
