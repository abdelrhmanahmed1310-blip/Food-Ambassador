-- CreateEnum
CREATE TYPE "ReferenceSource" AS ENUM ('USDA_FDC', 'OPEN_FOOD_FACTS', 'WIKIDATA');

-- AlterTable
ALTER TABLE "nutrition_profiles" ADD COLUMN     "reference_food_id" UUID;

-- CreateTable
CREATE TABLE "reference_foods" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source" "ReferenceSource" NOT NULL,
    "source_id" TEXT NOT NULL,
    "data_type" TEXT,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "description" TEXT,
    "brand" TEXT,
    "basis" "NutritionBasis",
    "energy_kcal" DECIMAL(12,4),
    "energy_kj" DECIMAL(12,4),
    "fat" DECIMAL(12,4),
    "saturated_fat" DECIMAL(12,4),
    "carbohydrate" DECIMAL(12,4),
    "sugars" DECIMAL(12,4),
    "fibre" DECIMAL(12,4),
    "protein" DECIMAL(12,4),
    "salt" DECIMAL(12,4),
    "sodium" DECIMAL(12,4),
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "traces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unmapped_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "licence" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "linked_product_id" UUID,
    "import_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reference_foods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_imports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source" "ReferenceSource" NOT NULL,
    "file_name" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "problems" JSONB NOT NULL DEFAULT '[]',
    "imported_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reference_foods_organization_id_name_idx" ON "reference_foods"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "reference_foods_organization_id_id_key" ON "reference_foods"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reference_foods_organization_id_source_source_id_key" ON "reference_foods"("organization_id", "source", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "reference_imports_organization_id_id_key" ON "reference_imports"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reference_imports_organization_id_sha256_key" ON "reference_imports"("organization_id", "sha256");

-- AddForeignKey
ALTER TABLE "nutrition_profiles" ADD CONSTRAINT "nutrition_profiles_organization_id_reference_food_id_fkey" FOREIGN KEY ("organization_id", "reference_food_id") REFERENCES "reference_foods"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_foods" ADD CONSTRAINT "reference_foods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_foods" ADD CONSTRAINT "reference_foods_organization_id_import_id_fkey" FOREIGN KEY ("organization_id", "import_id") REFERENCES "reference_imports"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_foods" ADD CONSTRAINT "reference_foods_organization_id_linked_product_id_fkey" FOREIGN KEY ("organization_id", "linked_product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_imports" ADD CONSTRAINT "reference_imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-041) ───

ALTER TABLE "reference_foods" ADD CONSTRAINT "reference_foods_values_ck"
  CHECK (COALESCE("energy_kcal", 0) >= 0 AND COALESCE("energy_kj", 0) >= 0
     AND COALESCE("fat", 0) >= 0 AND COALESCE("saturated_fat", 0) >= 0
     AND COALESCE("carbohydrate", 0) >= 0 AND COALESCE("sugars", 0) >= 0
     AND COALESCE("fibre", 0) >= 0 AND COALESCE("protein", 0) >= 0
     AND COALESCE("salt", 0) >= 0 AND COALESCE("sodium", 0) >= 0
     AND "allergens" <@ ARRAY['GLUTEN', 'CRUSTACEANS', 'EGGS', 'FISH', 'PEANUTS', 'SOY', 'MILK', 'TREE_NUTS',
                              'CELERY', 'MUSTARD', 'SESAME', 'SULPHITES', 'LUPIN', 'MOLLUSCS']::text[]
     AND "traces" <@ ARRAY['GLUTEN', 'CRUSTACEANS', 'EGGS', 'FISH', 'PEANUTS', 'SOY', 'MILK', 'TREE_NUTS',
                           'CELERY', 'MUSTARD', 'SESAME', 'SULPHITES', 'LUPIN', 'MOLLUSCS']::text[]
     AND length("licence") > 0 AND length("attribution") > 0);

-- Values copied from the library are database values.
ALTER TABLE "nutrition_profiles" ADD CONSTRAINT "nutrition_profiles_reference_ck"
  CHECK ("reference_food_id" IS NULL OR "source" = 'DATABASE');

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "reference_foods" TO fa_tenant;
GRANT SELECT, INSERT ON "reference_imports" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reference_foods', 'reference_imports']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
