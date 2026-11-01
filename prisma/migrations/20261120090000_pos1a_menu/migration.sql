-- CreateEnum
CREATE TYPE "SalesChannel" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');

-- CreateEnum
CREATE TYPE "MenuItemKind" AS ENUM ('ITEM', 'COMBO');

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "description" TEXT,
    "category_id" UUID NOT NULL,
    "kind" "MenuItemKind" NOT NULL DEFAULT 'ITEM',
    "recipe_id" UUID,
    "product_id" UUID,
    "product_quantity" DECIMAL(20,6),
    "tax_code_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_prices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "channel" "SalesChannel" NOT NULL,
    "branch_id" UUID,
    "price" DECIMAL(19,4) NOT NULL,
    "includes_tax" BOOLEAN NOT NULL,
    "effective_from" DATE NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_item_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "min_select" INTEGER NOT NULL DEFAULT 0,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_options" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "price_delta" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "recipe_id" UUID,
    "product_id" UUID,
    "quantity" DECIMAL(20,6),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_modifier_groups" (
    "organization_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_item_modifier_groups_pkey" PRIMARY KEY ("organization_id","item_id","group_id")
);

-- CreateTable
CREATE TABLE "combo_components" (
    "organization_id" UUID NOT NULL,
    "combo_id" UUID NOT NULL,
    "component_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL DEFAULT 1,

    CONSTRAINT "combo_components_pkey" PRIMARY KEY ("organization_id","combo_id","component_id")
);

-- CreateTable
CREATE TABLE "menu_item_unavailable" (
    "organization_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_item_unavailable_pkey" PRIMARY KEY ("organization_id","item_id","branch_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "menu_categories_organization_id_id_key" ON "menu_categories"("organization_id", "id");

-- CreateIndex
CREATE INDEX "menu_items_organization_id_category_id_idx" ON "menu_items"("organization_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_organization_id_id_key" ON "menu_items"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_organization_id_code_key" ON "menu_items"("organization_id", "code");

-- CreateIndex
CREATE INDEX "menu_item_prices_organization_id_item_id_idx" ON "menu_item_prices"("organization_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_groups_organization_id_id_key" ON "modifier_groups"("organization_id", "id");

-- CreateIndex
CREATE INDEX "modifier_options_organization_id_group_id_idx" ON "modifier_options"("organization_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_options_organization_id_id_key" ON "modifier_options"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "menu_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_organization_id_recipe_id_fkey" FOREIGN KEY ("organization_id", "recipe_id") REFERENCES "recipes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_prices" ADD CONSTRAINT "menu_item_prices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_prices" ADD CONSTRAINT "menu_item_prices_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "menu_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_prices" ADD CONSTRAINT "menu_item_prices_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_organization_id_group_id_fkey" FOREIGN KEY ("organization_id", "group_id") REFERENCES "modifier_groups"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_organization_id_recipe_id_fkey" FOREIGN KEY ("organization_id", "recipe_id") REFERENCES "recipes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "menu_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_organization_id_group_id_fkey" FOREIGN KEY ("organization_id", "group_id") REFERENCES "modifier_groups"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_organization_id_combo_id_fkey" FOREIGN KEY ("organization_id", "combo_id") REFERENCES "menu_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_organization_id_component_id_fkey" FOREIGN KEY ("organization_id", "component_id") REFERENCES "menu_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_unavailable" ADD CONSTRAINT "menu_item_unavailable_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_unavailable" ADD CONSTRAINT "menu_item_unavailable_organization_id_item_id_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "menu_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_unavailable" ADD CONSTRAINT "menu_item_unavailable_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Rules (ADR-058) ───

ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_values_ck"
  CHECK (length("name") BETWEEN 1 AND 120);
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_values_ck"
  CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$' AND length("name") BETWEEN 1 AND 160
     -- An item uses exactly one recipe or product; a combo uses neither (its components do).
     AND ("kind" <> 'ITEM' OR (("recipe_id" IS NULL) <> ("product_id" IS NULL)))
     AND ("kind" = 'ITEM' OR ("recipe_id" IS NULL AND "product_id" IS NULL))
     AND (("product_id" IS NULL) = ("product_quantity" IS NULL))
     AND ("product_quantity" IS NULL OR "product_quantity" > 0));
ALTER TABLE "menu_item_prices" ADD CONSTRAINT "menu_item_prices_values_ck" CHECK ("price" >= 0);
CREATE UNIQUE INDEX "menu_item_prices_key" ON "menu_item_prices"
  ("organization_id", "item_id", "channel", "branch_id", "effective_from") NULLS NOT DISTINCT;
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_values_ck"
  CHECK (length("name") BETWEEN 1 AND 120 AND "min_select" >= 0 AND "max_select" >= 1
     AND "min_select" <= "max_select" AND "max_select" <= 20);
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_values_ck"
  CHECK (length("name") BETWEEN 1 AND 120
     AND NOT ("recipe_id" IS NOT NULL AND "product_id" IS NOT NULL)
     AND (("recipe_id" IS NULL AND "product_id" IS NULL) = ("quantity" IS NULL))
     AND ("quantity" IS NULL OR "quantity" > 0));
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_values_ck"
  CHECK ("quantity" > 0 AND "combo_id" <> "component_id");

-- Prices are history: never changed or deleted.
CREATE TRIGGER "menu_item_prices_append_only" BEFORE UPDATE OR DELETE ON "menu_item_prices"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "menu_categories", "menu_items", "modifier_groups", "modifier_options" TO fa_tenant;
GRANT SELECT, INSERT ON "menu_item_prices" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "menu_item_modifier_groups", "combo_components", "menu_item_unavailable" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['menu_categories', 'menu_items', 'menu_item_prices', 'modifier_groups', 'modifier_options',
                           'menu_item_modifier_groups', 'combo_components', 'menu_item_unavailable']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- Menu permissions for existing organizations' system roles (ADR-058).
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'menu.view'), ('admin', 'menu.manage'),
  ('operations_manager', 'menu.view'), ('operations_manager', 'menu.manage'),
  ('branch_manager', 'menu.view'), ('finance', 'menu.view'), ('analyst', 'menu.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
