-- Photos for products and menu items, menu item barcodes, menu board channels (ADR-133).

-- AlterEnum
ALTER TYPE "OrderingChannelKind" ADD VALUE 'BOARD';

-- CreateTable
CREATE TABLE "media_images" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "content_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_images_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_images_organization_id_id_key" ON "media_images"("organization_id", "id");
ALTER TABLE "media_images" ADD CONSTRAINT "media_images_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Only re-encoded images are stored: WebP, at most 1200 px a side, at most 2 MB.
ALTER TABLE "media_images" ADD CONSTRAINT "media_images_content_type_check" CHECK ("content_type" = 'image/webp');
ALTER TABLE "media_images" ADD CONSTRAINT "media_images_size_check"
  CHECK ("width" BETWEEN 1 AND 1200 AND "height" BETWEEN 1 AND 1200
    AND "size_bytes" BETWEEN 1 AND 2097152 AND "size_bytes" = octet_length("data"));

-- AlterTable
ALTER TABLE "products" ADD COLUMN "image_id" UUID;
ALTER TABLE "menu_items" ADD COLUMN "barcode" TEXT, ADD COLUMN "image_id" UUID;
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_image_id_fkey" FOREIGN KEY ("organization_id", "image_id") REFERENCES "media_images"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_organization_id_image_id_fkey" FOREIGN KEY ("organization_id", "image_id") REFERENCES "media_images"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A barcode names one menu item per organization; printable characters as product barcodes allow.
CREATE UNIQUE INDEX "menu_items_barcode_key" ON "menu_items"("organization_id", "barcode") WHERE "barcode" IS NOT NULL;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_barcode_check"
  CHECK ("barcode" IS NULL OR "barcode" ~ '^[!-~]{1,64}$');

-- Tenant isolation
GRANT SELECT, INSERT, DELETE ON "media_images" TO fa_tenant;
ALTER TABLE "media_images" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "media_images"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
