-- Nutrition engine: nutrient dictionary, values, portions, source history, sync and data quality (DECISIONS.md ADR-132).

-- CreateEnum
CREATE TYPE "NutrientGroup" AS ENUM ('ENERGY', 'PROXIMATES', 'CARBOHYDRATES', 'LIPIDS', 'MINERALS', 'VITAMINS', 'AMINO_ACIDS', 'OTHER');

-- CreateEnum
CREATE TYPE "NutrientValueStatus" AS ENUM ('REPORTED', 'CALCULATED', 'BELOW_DETECTION', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "NutritionSyncKind" AS ENUM ('IMPORT', 'REFRESH', 'RELEASE_CHECK', 'BULK_FILE');

-- CreateEnum
CREATE TYPE "NutritionSyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "FoodIssueKind" AS ENUM ('MISSING_CORE_NUTRIENTS', 'IMPLAUSIBLE_VALUE', 'UNEXPECTED_UNIT', 'UNIT_MISMATCH', 'DUPLICATE_BARCODE', 'DUPLICATE_NAME', 'MISSING_SOURCE', 'STALE', 'CHANGED_AFTER_VERIFICATION');

-- CreateEnum
CREATE TYPE "FoodIssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- AlterEnum
ALTER TYPE "ReferenceSource" ADD VALUE 'MANUAL';

-- AlterTable
ALTER TABLE "reference_foods" ADD COLUMN     "archive_reason" TEXT,
ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "category_id" UUID,
ADD COLUMN     "content_hash" TEXT,
ADD COLUMN     "ingredients_text" TEXT,
ADD COLUMN     "last_fetched_at" TIMESTAMPTZ(3),
ADD COLUMN     "publication_date" DATE,
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_user_id" UUID,
ALTER COLUMN "import_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "nutrients" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" TEXT,
    "usda_nutrient_id" INTEGER,
    "usda_number" TEXT,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "unit" TEXT NOT NULL,
    "group" "NutrientGroup" NOT NULL DEFAULT 'OTHER',
    "rank" INTEGER NOT NULL DEFAULT 9999,
    "is_core" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nutrients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_nutrient_values" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "food_id" UUID NOT NULL,
    "nutrient_id" UUID NOT NULL,
    "status" "NutrientValueStatus" NOT NULL,
    "source_nutrient_id" INTEGER,
    "source_number" TEXT,
    "original_amount" DECIMAL(20,6),
    "original_unit" TEXT,
    "amount" DECIMAL(20,6),
    "unit" TEXT NOT NULL,
    "derivation_code" TEXT,
    "derivation_description" TEXT,
    "data_points" INTEGER,
    "note" TEXT,
    "version_id" UUID,

    CONSTRAINT "food_nutrient_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_portions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "food_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,4),
    "measure" TEXT,
    "description" TEXT NOT NULL,
    "description_ar" TEXT,
    "gram_weight" DECIMAL(14,4),
    "millilitres" DECIMAL(14,4),
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_portions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_source_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "food_id" UUID NOT NULL,
    "source" "ReferenceSource" NOT NULL,
    "source_id" TEXT NOT NULL,
    "data_type" TEXT,
    "publication_date" DATE,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "sync_job_id" UUID,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_source_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_aliases" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "food_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_identifiers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "food_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "food_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_categories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nutrition_settings" (
    "organization_id" UUID NOT NULL,
    "auto_refresh" BOOLEAN NOT NULL DEFAULT false,
    "refresh_days" INTEGER NOT NULL DEFAULT 90,
    "releases" JSONB NOT NULL DEFAULT '{}',
    "last_release_check_at" TIMESTAMPTZ(3),
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "nutrition_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "nutrition_sync_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "NutritionSyncKind" NOT NULL,
    "status" "NutritionSyncStatus" NOT NULL DEFAULT 'QUEUED',
    "request" JSONB NOT NULL DEFAULT '{}',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "nutrition_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_data_issues" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "food_id" UUID NOT NULL,
    "kind" "FoodIssueKind" NOT NULL,
    "status" "FoodIssueStatus" NOT NULL DEFAULT 'OPEN',
    "detail" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_note" TEXT,

    CONSTRAINT "food_data_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nutrients_organization_id_rank_idx" ON "nutrients"("organization_id", "rank");

-- CreateIndex
CREATE INDEX "food_nutrient_values_organization_id_nutrient_id_idx" ON "food_nutrient_values"("organization_id", "nutrient_id");

-- CreateIndex
CREATE UNIQUE INDEX "food_nutrient_values_organization_id_food_id_nutrient_id_key" ON "food_nutrient_values"("organization_id", "food_id", "nutrient_id");

-- CreateIndex
CREATE INDEX "food_portions_organization_id_food_id_sequence_idx" ON "food_portions"("organization_id", "food_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "food_portions_organization_id_id_key" ON "food_portions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "food_source_versions_organization_id_food_id_fetched_at_idx" ON "food_source_versions"("organization_id", "food_id", "fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "food_source_versions_organization_id_id_key" ON "food_source_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "food_source_versions_organization_id_food_id_payload_hash_key" ON "food_source_versions"("organization_id", "food_id", "payload_hash");

-- CreateIndex
CREATE UNIQUE INDEX "food_aliases_organization_id_food_id_locale_name_key" ON "food_aliases"("organization_id", "food_id", "locale", "name");

-- CreateIndex
CREATE INDEX "food_identifiers_organization_id_kind_value_idx" ON "food_identifiers"("organization_id", "kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "food_identifiers_organization_id_food_id_kind_value_key" ON "food_identifiers"("organization_id", "food_id", "kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "food_categories_organization_id_id_key" ON "food_categories"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "food_categories_organization_id_name_key" ON "food_categories"("organization_id", "name");

-- CreateIndex
CREATE INDEX "nutrition_sync_jobs_organization_id_created_at_idx" ON "nutrition_sync_jobs"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "nutrition_sync_jobs_organization_id_id_key" ON "nutrition_sync_jobs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "food_data_issues_organization_id_status_kind_idx" ON "food_data_issues"("organization_id", "status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "food_data_issues_organization_id_id_key" ON "food_data_issues"("organization_id", "id");

-- CreateIndex
CREATE INDEX "reference_foods_organization_id_barcode_idx" ON "reference_foods"("organization_id", "barcode");

-- CreateIndex
CREATE INDEX "reference_foods_organization_id_last_fetched_at_idx" ON "reference_foods"("organization_id", "last_fetched_at");

-- AddForeignKey
ALTER TABLE "reference_foods" ADD CONSTRAINT "reference_foods_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "food_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nutrients" ADD CONSTRAINT "nutrients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_nutrient_values" ADD CONSTRAINT "food_nutrient_values_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_nutrient_values" ADD CONSTRAINT "food_nutrient_values_organization_id_food_id_fkey" FOREIGN KEY ("organization_id", "food_id") REFERENCES "reference_foods"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_nutrient_values" ADD CONSTRAINT "food_nutrient_values_nutrient_id_fkey" FOREIGN KEY ("nutrient_id") REFERENCES "nutrients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_nutrient_values" ADD CONSTRAINT "food_nutrient_values_organization_id_version_id_fkey" FOREIGN KEY ("organization_id", "version_id") REFERENCES "food_source_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_portions" ADD CONSTRAINT "food_portions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_portions" ADD CONSTRAINT "food_portions_organization_id_food_id_fkey" FOREIGN KEY ("organization_id", "food_id") REFERENCES "reference_foods"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_source_versions" ADD CONSTRAINT "food_source_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_source_versions" ADD CONSTRAINT "food_source_versions_organization_id_food_id_fkey" FOREIGN KEY ("organization_id", "food_id") REFERENCES "reference_foods"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_aliases" ADD CONSTRAINT "food_aliases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_aliases" ADD CONSTRAINT "food_aliases_organization_id_food_id_fkey" FOREIGN KEY ("organization_id", "food_id") REFERENCES "reference_foods"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_identifiers" ADD CONSTRAINT "food_identifiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_identifiers" ADD CONSTRAINT "food_identifiers_organization_id_food_id_fkey" FOREIGN KEY ("organization_id", "food_id") REFERENCES "reference_foods"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_categories" ADD CONSTRAINT "food_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nutrition_settings" ADD CONSTRAINT "nutrition_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nutrition_sync_jobs" ADD CONSTRAINT "nutrition_sync_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_data_issues" ADD CONSTRAINT "food_data_issues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_data_issues" ADD CONSTRAINT "food_data_issues_organization_id_food_id_fkey" FOREIGN KEY ("organization_id", "food_id") REFERENCES "reference_foods"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Nutrition engine (ADR-132): hand-written rules ───
-- Shared dictionary rows (organization NULL) are unique by USDA id and by code; an organization's
-- custom codes are unique within it.
CREATE UNIQUE INDEX "nutrients_usda_key" ON "nutrients" ("usda_nutrient_id") WHERE "organization_id" IS NULL AND "usda_nutrient_id" IS NOT NULL;
CREATE UNIQUE INDEX "nutrients_shared_code_key" ON "nutrients" ("code") WHERE "organization_id" IS NULL AND "code" IS NOT NULL;
CREATE UNIQUE INDEX "nutrients_org_code_key" ON "nutrients" ("organization_id", "code") WHERE "organization_id" IS NOT NULL AND "code" IS NOT NULL;
ALTER TABLE "nutrients" ADD CONSTRAINT "nutrients_ck" CHECK (
  length("name") BETWEEN 1 AND 200 AND "unit" IN ('g', 'mg', 'µg', 'kcal', 'kJ', 'IU')
  AND ("code" IS NULL OR "code" ~ '^[a-z][a-z0-9_]{1,59}$')
  AND ("organization_id" IS NULL OR "usda_nutrient_id" IS NULL));
-- A value is never negative; a REPORTED or CALCULATED value has an amount or an original amount.
ALTER TABLE "food_nutrient_values" ADD CONSTRAINT "food_nutrient_values_ck" CHECK (
  COALESCE("amount", 0) >= 0 AND COALESCE("original_amount", 0) >= 0
  AND ("status" NOT IN ('REPORTED', 'CALCULATED') OR "amount" IS NOT NULL OR "original_amount" IS NOT NULL));
ALTER TABLE "food_portions" ADD CONSTRAINT "food_portions_ck" CHECK (
  length("description") BETWEEN 1 AND 300 AND COALESCE("gram_weight", 1) > 0
  AND COALESCE("millilitres", 1) > 0 AND COALESCE("amount", 1) > 0);
ALTER TABLE "food_aliases" ADD CONSTRAINT "food_aliases_ck" CHECK (
  "locale" IN ('en', 'ar') AND length("name") BETWEEN 1 AND 300);
ALTER TABLE "food_identifiers" ADD CONSTRAINT "food_identifiers_ck" CHECK (
  "kind" IN ('FDC_ID', 'GTIN_UPC', 'NDB_NUMBER', 'FOOD_CODE', 'OFF_CODE', 'WIKIDATA_QID') AND length("value") BETWEEN 1 AND 64);
ALTER TABLE "food_source_versions" ADD CONSTRAINT "food_source_versions_ck" CHECK ("via" IN ('API', 'BULK_FILE', 'FILE'));
ALTER TABLE "nutrition_settings" ADD CONSTRAINT "nutrition_settings_ck" CHECK ("refresh_days" BETWEEN 1 AND 3650);
ALTER TABLE "nutrition_sync_jobs" ADD CONSTRAINT "nutrition_sync_jobs_ck" CHECK (
  "processed" >= 0 AND "created" >= 0 AND "updated" >= 0 AND "unchanged" >= 0 AND "failed" >= 0);
ALTER TABLE "food_data_issues" ADD CONSTRAINT "food_data_issues_ck" CHECK (
  ("status" = 'OPEN') = ("resolved_at" IS NULL));
-- One open finding of a kind per food.
CREATE UNIQUE INDEX "food_data_issues_open_key" ON "food_data_issues" ("organization_id", "food_id", "kind") WHERE "status" = 'OPEN';
-- Search: names and aliases by similarity, in English and Arabic.
CREATE INDEX "reference_foods_name_trgm" ON "reference_foods" USING gin ("name" gin_trgm_ops);
CREATE INDEX "reference_foods_name_ar_trgm" ON "reference_foods" USING gin ("name_ar" gin_trgm_ops);
CREATE INDEX "reference_foods_brand_trgm" ON "reference_foods" USING gin ("brand" gin_trgm_ops);
CREATE INDEX "food_aliases_name_trgm" ON "food_aliases" USING gin ("name" gin_trgm_ops);
-- Source history is kept as published.
CREATE OR REPLACE FUNCTION "food_source_versions_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a source record is kept as published' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "food_source_versions_fixed" BEFORE UPDATE ON "food_source_versions"
  FOR EACH ROW EXECUTE FUNCTION "food_source_versions_fixed"();

-- The shared dictionary is read by everyone; an organization adds and edits its own nutrients.
GRANT SELECT, INSERT, UPDATE ON "nutrients" TO fa_tenant;
ALTER TABLE "nutrients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "nutrients_read" ON "nutrients" FOR SELECT
  USING ("organization_id" IS NULL OR "organization_id" = current_organization_id());
CREATE POLICY "nutrients_insert" ON "nutrients" FOR INSERT
  WITH CHECK ("organization_id" = current_organization_id());
CREATE POLICY "nutrients_update" ON "nutrients" FOR UPDATE
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "food_nutrient_values", "food_portions", "food_aliases",
  "food_identifiers" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "food_categories", "nutrition_settings", "nutrition_sync_jobs",
  "food_data_issues" TO fa_tenant;
GRANT SELECT, INSERT ON "food_source_versions" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['food_nutrient_values', 'food_portions', 'food_source_versions', 'food_aliases',
    'food_identifiers', 'food_categories', 'nutrition_settings', 'nutrition_sync_jobs', 'food_data_issues'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

-- The nutrient dictionary: USDA FoodData Central nutrient ids, numbers, names and units, with the
-- app's codes. Arabic names are given for label nutrients and common vitamins and minerals; the
-- rest show in English until reviewed (ADR-132). Nutrients a source adds later are inserted on import.
INSERT INTO "nutrients" ("id", "code", "usda_nutrient_id", "usda_number", "name", "name_ar", "unit", "group", "rank", "is_core")
SELECT gen_random_uuid(), v.code, v.usda_nutrient_id, v.usda_number, v.name, v.name_ar, v.unit, v.grp::"NutrientGroup", v.rank, v.is_core FROM (VALUES
  ('energy_kcal', 1008, '208', 'Energy', 'الطاقة', 'kcal', 'ENERGY', 10, TRUE),
  ('energy_kj', 1062, '268', 'Energy (kJ)', 'الطاقة (كيلوجول)', 'kJ', 'ENERGY', 11, TRUE),
  ('energy_atwater_general', 2047, '957', 'Energy (Atwater General Factors)', NULL, 'kcal', 'ENERGY', 12, FALSE),
  ('energy_atwater_specific', 2048, '958', 'Energy (Atwater Specific Factors)', NULL, 'kcal', 'ENERGY', 13, FALSE),
  ('water', 1051, '255', 'Water', 'الماء', 'g', 'PROXIMATES', 20, FALSE),
  ('protein', 1003, '203', 'Protein', 'البروتين', 'g', 'PROXIMATES', 21, TRUE),
  ('fat', 1004, '204', 'Total lipid (fat)', 'الدهون الكلية', 'g', 'LIPIDS', 30, TRUE),
  ('saturated_fat', 1258, '606', 'Fatty acids, total saturated', 'الدهون المشبعة', 'g', 'LIPIDS', 31, TRUE),
  ('trans_fat', 1257, '605', 'Fatty acids, total trans', 'الدهون المتحولة', 'g', 'LIPIDS', 32, TRUE),
  ('monounsaturated_fat', 1292, '645', 'Fatty acids, total monounsaturated', 'الدهون الأحادية غير المشبعة', 'g', 'LIPIDS', 33, FALSE),
  ('polyunsaturated_fat', 1293, '646', 'Fatty acids, total polyunsaturated', 'الدهون المتعددة غير المشبعة', 'g', 'LIPIDS', 34, FALSE),
  ('cholesterol', 1253, '601', 'Cholesterol', 'الكوليسترول', 'mg', 'LIPIDS', 35, TRUE),
  ('carbohydrate', 1005, '205', 'Carbohydrate, by difference', 'الكربوهيدرات', 'g', 'CARBOHYDRATES', 40, TRUE),
  ('carbohydrate_by_summation', 1050, '205.2', 'Carbohydrate, by summation', NULL, 'g', 'CARBOHYDRATES', 41, FALSE),
  ('fibre', 1079, '291', 'Fiber, total dietary', 'الألياف الغذائية', 'g', 'CARBOHYDRATES', 42, TRUE),
  ('sugars', 2000, '269', 'Total Sugars', 'السكريات الكلية', 'g', 'CARBOHYDRATES', 43, TRUE),
  ('sugars_total', 1063, '269.3', 'Sugars, Total', NULL, 'g', 'CARBOHYDRATES', 44, FALSE),
  ('added_sugars', 1235, '539', 'Sugars, added', 'السكريات المضافة', 'g', 'CARBOHYDRATES', 45, TRUE),
  ('sodium', 1093, '307', 'Sodium, Na', 'الصوديوم', 'mg', 'MINERALS', 50, TRUE),
  ('salt', NULL, NULL, 'Salt', 'الملح', 'g', 'MINERALS', 51, TRUE),
  ('calcium', 1087, '301', 'Calcium, Ca', 'الكالسيوم', 'mg', 'MINERALS', 52, FALSE),
  ('iron', 1089, '303', 'Iron, Fe', 'الحديد', 'mg', 'MINERALS', 53, FALSE),
  ('magnesium', 1090, '304', 'Magnesium, Mg', 'المغنيسيوم', 'mg', 'MINERALS', 54, FALSE),
  ('phosphorus', 1091, '305', 'Phosphorus, P', 'الفوسفور', 'mg', 'MINERALS', 55, FALSE),
  ('potassium', 1092, '306', 'Potassium, K', 'البوتاسيوم', 'mg', 'MINERALS', 56, FALSE),
  ('zinc', 1095, '309', 'Zinc, Zn', 'الزنك', 'mg', 'MINERALS', 57, FALSE),
  ('copper', 1098, '312', 'Copper, Cu', 'النحاس', 'mg', 'MINERALS', 58, FALSE),
  ('manganese', 1101, '315', 'Manganese, Mn', 'المنغنيز', 'mg', 'MINERALS', 59, FALSE),
  ('selenium', 1103, '317', 'Selenium, Se', 'السيلينيوم', 'µg', 'MINERALS', 60, FALSE),
  ('vitamin_a_rae', 1106, '320', 'Vitamin A, RAE', 'فيتامين A', 'µg', 'VITAMINS', 70, FALSE),
  ('vitamin_a_iu', 1104, '318', 'Vitamin A, IU', NULL, 'IU', 'VITAMINS', 71, FALSE),
  ('vitamin_c', 1162, '401', 'Vitamin C, total ascorbic acid', 'فيتامين C', 'mg', 'VITAMINS', 72, FALSE),
  ('vitamin_d', 1114, '328', 'Vitamin D (D2 + D3)', 'فيتامين D', 'µg', 'VITAMINS', 73, FALSE),
  ('vitamin_d_iu', 1110, '324', 'Vitamin D (D2 + D3), International Units', NULL, 'IU', 'VITAMINS', 74, FALSE),
  ('vitamin_e', 1109, '323', 'Vitamin E (alpha-tocopherol)', 'فيتامين E', 'mg', 'VITAMINS', 75, FALSE),
  ('vitamin_k', 1185, '430', 'Vitamin K (phylloquinone)', 'فيتامين K', 'µg', 'VITAMINS', 76, FALSE),
  ('thiamin', 1165, '404', 'Thiamin', 'الثيامين (فيتامين B1)', 'mg', 'VITAMINS', 77, FALSE),
  ('riboflavin', 1166, '405', 'Riboflavin', 'الريبوفلافين (فيتامين B2)', 'mg', 'VITAMINS', 78, FALSE),
  ('niacin', 1167, '406', 'Niacin', 'النياسين (فيتامين B3)', 'mg', 'VITAMINS', 79, FALSE),
  ('pantothenic_acid', 1170, '410', 'Pantothenic acid', NULL, 'mg', 'VITAMINS', 80, FALSE),
  ('vitamin_b6', 1175, '415', 'Vitamin B-6', 'فيتامين B6', 'mg', 'VITAMINS', 81, FALSE),
  ('folate', 1177, '417', 'Folate, total', 'الفولات', 'µg', 'VITAMINS', 82, FALSE),
  ('folate_dfe', 1190, '435', 'Folate, DFE', NULL, 'µg', 'VITAMINS', 83, FALSE),
  ('vitamin_b12', 1178, '418', 'Vitamin B-12', 'فيتامين B12', 'µg', 'VITAMINS', 84, FALSE),
  ('choline', 1180, '421', 'Choline, total', NULL, 'mg', 'VITAMINS', 85, FALSE),
  ('tryptophan', 1210, '501', 'Tryptophan', NULL, 'g', 'AMINO_ACIDS', 90, FALSE),
  ('threonine', 1211, '502', 'Threonine', NULL, 'g', 'AMINO_ACIDS', 91, FALSE),
  ('isoleucine', 1212, '503', 'Isoleucine', NULL, 'g', 'AMINO_ACIDS', 92, FALSE),
  ('leucine', 1213, '504', 'Leucine', NULL, 'g', 'AMINO_ACIDS', 93, FALSE),
  ('lysine', 1214, '505', 'Lysine', NULL, 'g', 'AMINO_ACIDS', 94, FALSE),
  ('methionine', 1215, '506', 'Methionine', NULL, 'g', 'AMINO_ACIDS', 95, FALSE),
  ('phenylalanine', 1217, '508', 'Phenylalanine', NULL, 'g', 'AMINO_ACIDS', 96, FALSE),
  ('valine', 1219, '510', 'Valine', NULL, 'g', 'AMINO_ACIDS', 97, FALSE),
  ('histidine', 1221, '512', 'Histidine', NULL, 'g', 'AMINO_ACIDS', 98, FALSE),
  ('alcohol', 1018, '221', 'Alcohol, ethyl', NULL, 'g', 'OTHER', 100, FALSE),
  ('caffeine', 1057, '262', 'Caffeine', NULL, 'mg', 'OTHER', 101, FALSE),
  ('ash', 1007, '207', 'Ash', NULL, 'g', 'PROXIMATES', 102, FALSE)
) AS v(code, usda_nutrient_id, usda_number, name, name_ar, unit, grp, rank, is_core)
ON CONFLICT DO NOTHING;
