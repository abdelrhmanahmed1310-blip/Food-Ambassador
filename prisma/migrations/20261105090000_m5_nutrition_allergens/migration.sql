-- CreateEnum
CREATE TYPE "AllergenStatus" AS ENUM ('CONTAINS', 'MAY_CONTAIN', 'FREE_FROM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "NutritionSource" AS ENUM ('SUPPLIER_SPEC', 'LAB', 'DATABASE', 'MANUAL');

-- CreateEnum
CREATE TYPE "NutritionBasis" AS ENUM ('PER_100G', 'PER_100ML');

-- CreateEnum
CREATE TYPE "LabelStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "allergen_declarations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "allergen" TEXT NOT NULL,
    "status" "AllergenStatus" NOT NULL,
    "source" "NutritionSource" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "declared_by_user_id" UUID NOT NULL,
    "declared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "allergen_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nutrition_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "basis" "NutritionBasis" NOT NULL,
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
    "source" "NutritionSource" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "nutrition_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_labels" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "label_no" INTEGER NOT NULL,
    "status" "LabelStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "content" JSONB NOT NULL,
    "inputs_hash" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "recipe_labels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "allergen_declarations_organization_id_product_id_allergen_idx" ON "allergen_declarations"("organization_id", "product_id", "allergen");

-- CreateIndex
CREATE UNIQUE INDEX "allergen_declarations_organization_id_id_key" ON "allergen_declarations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "nutrition_profiles_organization_id_product_id_idx" ON "nutrition_profiles"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "nutrition_profiles_organization_id_id_key" ON "nutrition_profiles"("organization_id", "id");

-- CreateIndex
CREATE INDEX "recipe_labels_organization_id_recipe_id_status_idx" ON "recipe_labels"("organization_id", "recipe_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_labels_organization_id_id_key" ON "recipe_labels"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_labels_organization_id_recipe_id_label_no_key" ON "recipe_labels"("organization_id", "recipe_id", "label_no");

-- AddForeignKey
ALTER TABLE "allergen_declarations" ADD CONSTRAINT "allergen_declarations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allergen_declarations" ADD CONSTRAINT "allergen_declarations_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nutrition_profiles" ADD CONSTRAINT "nutrition_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nutrition_profiles" ADD CONSTRAINT "nutrition_profiles_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_labels" ADD CONSTRAINT "recipe_labels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_labels" ADD CONSTRAINT "recipe_labels_organization_id_recipe_id_fkey" FOREIGN KEY ("organization_id", "recipe_id") REFERENCES "recipes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_labels" ADD CONSTRAINT "recipe_labels_organization_id_version_id_fkey" FOREIGN KEY ("organization_id", "version_id") REFERENCES "recipe_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-040) ───

ALTER TABLE "allergen_declarations" ADD CONSTRAINT "allergen_declarations_values_ck"
  CHECK ("allergen" IN ('GLUTEN', 'CRUSTACEANS', 'EGGS', 'FISH', 'PEANUTS', 'SOY', 'MILK', 'TREE_NUTS',
                        'CELERY', 'MUSTARD', 'SESAME', 'SULPHITES', 'LUPIN', 'MOLLUSCS')
     -- "Free from" is a claim: it needs evidence and never comes from a food database.
     AND ("status" <> 'FREE_FROM' OR ("reference" IS NOT NULL AND "source" <> 'DATABASE'))
     AND ("verified_by_user_id" IS NULL OR "verified_by_user_id" <> "declared_by_user_id")
     AND (("verified_at" IS NULL) = ("verified_by_user_id" IS NULL)));

ALTER TABLE "nutrition_profiles" ADD CONSTRAINT "nutrition_profiles_values_ck"
  CHECK (COALESCE("energy_kcal", 0) >= 0 AND COALESCE("energy_kj", 0) >= 0
     AND COALESCE("fat", 0) >= 0 AND COALESCE("saturated_fat", 0) >= 0
     AND COALESCE("carbohydrate", 0) >= 0 AND COALESCE("sugars", 0) >= 0
     AND COALESCE("fibre", 0) >= 0 AND COALESCE("protein", 0) >= 0
     AND COALESCE("salt", 0) >= 0 AND COALESCE("sodium", 0) >= 0
     AND ("saturated_fat" IS NULL OR "fat" IS NULL OR "saturated_fat" <= "fat")
     AND ("sugars" IS NULL OR "carbohydrate" IS NULL OR "sugars" <= "carbohydrate")
     AND ("basis" <> 'PER_100G' OR (
          COALESCE("fat", 0) <= 100 AND COALESCE("carbohydrate", 0) <= 100
      AND COALESCE("fibre", 0) <= 100 AND COALESCE("protein", 0) <= 100
      AND COALESCE("salt", 0) <= 100 AND COALESCE("sodium", 0) <= 40
      AND COALESCE("energy_kcal", 0) <= 1000 AND COALESCE("energy_kj", 0) <= 4200))
     AND ("verified_by_user_id" IS NULL OR "verified_by_user_id" <> "created_by_user_id")
     AND (("verified_at" IS NULL) = ("verified_by_user_id" IS NULL)));

ALTER TABLE "recipe_labels" ADD CONSTRAINT "recipe_labels_values_ck"
  CHECK ("label_no" > 0
     AND (("status" IN ('APPROVED', 'REJECTED', 'SUPERSEDED')) = ("reviewed_at" IS NOT NULL))
     AND (("status" = 'SUPERSEDED') = ("superseded_at" IS NOT NULL))
     AND ("reviewed_by_user_id" IS NULL OR "reviewed_by_user_id" <> "created_by_user_id"));

-- One current statement per product and allergen, one current profile per product.
CREATE UNIQUE INDEX "allergen_declarations_current" ON "allergen_declarations" ("organization_id", "product_id", "allergen")
  WHERE "superseded_at" IS NULL;
CREATE UNIQUE INDEX "nutrition_profiles_current" ON "nutrition_profiles" ("organization_id", "product_id")
  WHERE "superseded_at" IS NULL;
-- At most one label waiting for review and one approved label per recipe.
CREATE UNIQUE INDEX "recipe_labels_one_pending" ON "recipe_labels" ("organization_id", "recipe_id")
  WHERE "status" = 'PENDING_REVIEW';
CREATE UNIQUE INDEX "recipe_labels_one_approved" ON "recipe_labels" ("organization_id", "recipe_id")
  WHERE "status" = 'APPROVED';

-- ─── Append-only history ───

-- Declarations and profiles: only verification (once) and superseding (once) may change.
CREATE FUNCTION "nutrition_record_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE free text[] := ARRAY['verified_by_user_id', 'verified_at', 'superseded_at'];
BEGIN
  IF (to_jsonb(NEW) - free) <> (to_jsonb(OLD) - free)
     OR (OLD."verified_at" IS NOT NULL AND NEW."verified_at" IS DISTINCT FROM OLD."verified_at")
     OR (OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at")
     OR (OLD."superseded_at" IS NOT NULL AND NEW."verified_at" IS DISTINCT FROM OLD."verified_at") THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "allergen_declarations_append_only" BEFORE UPDATE ON "allergen_declarations"
  FOR EACH ROW EXECUTE FUNCTION "nutrition_record_append_only"();
CREATE TRIGGER "nutrition_profiles_append_only" BEFORE UPDATE ON "nutrition_profiles"
  FOR EACH ROW EXECUTE FUNCTION "nutrition_record_append_only"();

-- Labels: content is fixed; status moves PENDING_REVIEW → APPROVED | REJECTED, APPROVED → SUPERSEDED.
CREATE FUNCTION "recipe_label_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE free text[] := ARRAY['status', 'reviewed_by_user_id', 'reviewed_at', 'review_note', 'superseded_at'];
BEGIN
  IF (to_jsonb(NEW) - free) <> (to_jsonb(OLD) - free)
     OR NOT ((OLD."status" = 'PENDING_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED'))
          OR (OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED'
              AND NEW."reviewed_at" = OLD."reviewed_at" AND NEW."reviewed_by_user_id" = OLD."reviewed_by_user_id")) THEN
    RAISE EXCEPTION 'recipe label cannot change from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "recipe_labels_transition" BEFORE UPDATE ON "recipe_labels"
  FOR EACH ROW EXECUTE FUNCTION "recipe_label_transition"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "allergen_declarations", "nutrition_profiles", "recipe_labels" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['allergen_declarations', 'nutrition_profiles', 'recipe_labels']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- ─── New permissions for existing organizations' system roles ───
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'nutrition.view'), ('admin', 'nutrition.manage'), ('admin', 'labels.approve'),
  ('operations_manager', 'nutrition.view'), ('operations_manager', 'nutrition.manage'), ('operations_manager', 'labels.approve'),
  ('procurement', 'nutrition.view'), ('procurement', 'nutrition.manage'),
  ('warehouse', 'nutrition.view'),
  ('food_safety', 'nutrition.view'), ('food_safety', 'nutrition.manage'), ('food_safety', 'labels.approve'),
  ('branch_manager', 'nutrition.view'),
  ('analyst', 'nutrition.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
