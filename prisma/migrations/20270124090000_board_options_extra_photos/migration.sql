-- Menu board theme and pages, board hours per menu category, extra photos (ADR-133).


ALTER TABLE "menu_categories" ADD COLUMN     "board_from" TEXT,
ADD COLUMN     "board_to" TEXT;

ALTER TABLE "ordering_channels" ADD COLUMN     "board_page_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "board_theme" TEXT NOT NULL DEFAULT 'LIGHT';

CREATE TABLE "item_photos" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID,
    "menu_item_id" UUID,
    "image_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "item_photos_organization_id_product_id_idx" ON "item_photos"("organization_id", "product_id");

CREATE INDEX "item_photos_organization_id_menu_item_id_idx" ON "item_photos"("organization_id", "menu_item_id");

CREATE UNIQUE INDEX "item_photos_organization_id_id_key" ON "item_photos"("organization_id", "id");

ALTER TABLE "item_photos" ADD CONSTRAINT "item_photos_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "item_photos" ADD CONSTRAINT "item_photos_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "item_photos" ADD CONSTRAINT "item_photos_organization_id_menu_item_id_fkey" FOREIGN KEY ("organization_id", "menu_item_id") REFERENCES "menu_items"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "item_photos" ADD CONSTRAINT "item_photos_organization_id_image_id_fkey" FOREIGN KEY ("organization_id", "image_id") REFERENCES "media_images"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Board options and hours are checked like the ordering page's opening hours (HH:MM).
ALTER TABLE "ordering_channels" ADD CONSTRAINT "ordering_channels_board_theme_check"
  CHECK ("board_theme" IN ('LIGHT', 'DARK'));
ALTER TABLE "ordering_channels" ADD CONSTRAINT "ordering_channels_board_page_seconds_check"
  CHECK ("board_page_seconds" = 0 OR "board_page_seconds" BETWEEN 5 AND 300);
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_board_hours_check"
  CHECK (("board_from" IS NULL) = ("board_to" IS NULL)
    AND ("board_from" IS NULL OR ("board_from" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "board_to" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "board_from" <> "board_to")));
-- An extra photo belongs to exactly one product or menu item.
ALTER TABLE "item_photos" ADD CONSTRAINT "item_photos_owner_check"
  CHECK (("product_id" IS NULL) <> ("menu_item_id" IS NULL));

GRANT SELECT, INSERT, DELETE ON "item_photos" TO fa_tenant;
ALTER TABLE "item_photos" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "item_photos"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
