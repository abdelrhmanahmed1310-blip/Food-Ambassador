-- M3c-1: product categories and reorder rules (DECISIONS.md ADR-025).

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "category_id" UUID;

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reorder_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "min_quantity_base" DECIMAL(20,6) NOT NULL,
    "max_quantity_base" DECIMAL(20,6) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reorder_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_organization_id_id_key" ON "product_categories"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_organization_id_code_key" ON "product_categories"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "reorder_rules_organization_id_id_key" ON "reorder_rules"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reorder_rules_organization_id_warehouse_id_product_id_key" ON "reorder_rules"("organization_id", "warehouse_id", "product_id");

-- CreateIndex
CREATE INDEX "products_organization_id_category_id_idx" ON "products"("organization_id", "category_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "product_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Constraints ───

ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_quantities_ck"
  CHECK ("min_quantity_base" >= 0 AND "max_quantity_base" > 0 AND "max_quantity_base" >= "min_quantity_base");

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "product_categories" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "reorder_rules" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_categories', 'reorder_rules']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
