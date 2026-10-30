-- CreateEnum
CREATE TYPE "RecipeType" AS ENUM ('DISH', 'PREPARATION');

-- CreateEnum
CREATE TYPE "RecipeVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "RecipeCostPolicy" AS ENUM ('AVERAGE', 'LAST_PURCHASE', 'STANDARD');

-- CreateEnum
CREATE TYPE "RecipeSnapshotReason" AS ENUM ('ACTIVATION', 'MANUAL');

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "type" "RecipeType" NOT NULL,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "RecipeVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "yield_quantity" DECIMAL(20,6) NOT NULL,
    "yield_uom_id" UUID NOT NULL,
    "portions" DECIMAL(20,6),
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "activated_by_user_id" UUID,
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recipe_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID,
    "sub_recipe_id" UUID,
    "quantity" DECIMAL(20,6) NOT NULL,
    "uom_id" UUID NOT NULL,
    "waste_fraction" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_standard_costs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_cost" DECIMAL(20,6) NOT NULL,
    "effective_from" DATE NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_standard_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_cost_snapshots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "reason" "RecipeSnapshotReason" NOT NULL,
    "policy" "RecipeCostPolicy" NOT NULL,
    "warehouse_id" UUID,
    "as_of" DATE NOT NULL,
    "total_cost" DECIMAL(19,4) NOT NULL,
    "cost_per_portion" DECIMAL(19,4),
    "cost_per_yield_unit" DECIMAL(20,6) NOT NULL,
    "missing_count" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "calculated_by_user_id" UUID NOT NULL,
    "calculated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_cost_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipes_organization_id_id_key" ON "recipes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_organization_id_code_key" ON "recipes"("organization_id", "code");

-- CreateIndex
CREATE INDEX "recipe_versions_organization_id_recipe_id_status_idx" ON "recipe_versions"("organization_id", "recipe_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_versions_organization_id_id_key" ON "recipe_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_versions_organization_id_recipe_id_version_no_key" ON "recipe_versions"("organization_id", "recipe_id", "version_no");

-- CreateIndex
CREATE INDEX "recipe_ingredients_organization_id_product_id_idx" ON "recipe_ingredients"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "recipe_ingredients_organization_id_sub_recipe_id_idx" ON "recipe_ingredients"("organization_id", "sub_recipe_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_ingredients_organization_id_id_key" ON "recipe_ingredients"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_ingredients_organization_id_version_id_line_no_key" ON "recipe_ingredients"("organization_id", "version_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "product_standard_costs_organization_id_id_key" ON "product_standard_costs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_standard_costs_organization_id_product_id_effective_key" ON "product_standard_costs"("organization_id", "product_id", "effective_from");

-- CreateIndex
CREATE INDEX "recipe_cost_snapshots_organization_id_version_id_calculated_idx" ON "recipe_cost_snapshots"("organization_id", "version_id", "calculated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "recipe_cost_snapshots_organization_id_id_key" ON "recipe_cost_snapshots"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_organization_id_recipe_id_fkey" FOREIGN KEY ("organization_id", "recipe_id") REFERENCES "recipes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_yield_uom_id_fkey" FOREIGN KEY ("yield_uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_organization_id_version_id_fkey" FOREIGN KEY ("organization_id", "version_id") REFERENCES "recipe_versions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_organization_id_sub_recipe_id_fkey" FOREIGN KEY ("organization_id", "sub_recipe_id") REFERENCES "recipes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_standard_costs" ADD CONSTRAINT "product_standard_costs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_standard_costs" ADD CONSTRAINT "product_standard_costs_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_cost_snapshots" ADD CONSTRAINT "recipe_cost_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_cost_snapshots" ADD CONSTRAINT "recipe_cost_snapshots_organization_id_version_id_fkey" FOREIGN KEY ("organization_id", "version_id") REFERENCES "recipe_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_cost_snapshots" ADD CONSTRAINT "recipe_cost_snapshots_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-030) ───

ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_values_ck"
  CHECK ("yield_quantity" > 0 AND ("portions" IS NULL OR "portions" > 0) AND "version_no" > 0
         AND ("status" = 'DRAFT' OR "activated_at" IS NOT NULL)
         AND ("status" <> 'RETIRED' OR "retired_at" IS NOT NULL));
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_values_ck"
  CHECK ((("product_id" IS NULL) <> ("sub_recipe_id" IS NULL))
         AND "quantity" > 0 AND "line_no" > 0
         AND "waste_fraction" >= 0 AND "waste_fraction" < 1);
ALTER TABLE "product_standard_costs" ADD CONSTRAINT "product_standard_costs_cost_ck"
  CHECK ("unit_cost" >= 0);
ALTER TABLE "recipe_cost_snapshots" ADD CONSTRAINT "recipe_cost_snapshots_values_ck"
  CHECK ("total_cost" >= 0 AND "cost_per_yield_unit" >= 0 AND "missing_count" >= 0
         AND ("cost_per_portion" IS NULL OR "cost_per_portion" >= 0));

-- At most one active and one draft version per recipe.
CREATE UNIQUE INDEX "recipe_versions_one_active" ON "recipe_versions" ("organization_id", "recipe_id")
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "recipe_versions_one_draft" ON "recipe_versions" ("organization_id", "recipe_id")
  WHERE "status" = 'DRAFT';

-- ─── Only drafts change ───

-- A non-draft version may only move ACTIVE → RETIRED; its content is fixed.
CREATE FUNCTION "recipe_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'recipe version % is % and cannot be deleted', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED'
     AND NEW."recipe_id" = OLD."recipe_id" AND NEW."version_no" = OLD."version_no"
     AND NEW."yield_quantity" = OLD."yield_quantity" AND NEW."yield_uom_id" = OLD."yield_uom_id"
     AND NEW."portions" IS NOT DISTINCT FROM OLD."portions"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."activated_at" = OLD."activated_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'recipe version % is % and cannot be changed', OLD."id", OLD."status"
    USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER "recipe_versions_guard" BEFORE UPDATE OR DELETE ON "recipe_versions"
  FOR EACH ROW EXECUTE FUNCTION "recipe_version_guard"();

CREATE FUNCTION "recipe_ingredient_draft_only"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "RecipeVersionStatus";
BEGIN
  SELECT "status" INTO s FROM "recipe_versions"
  WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."version_id" ELSE NEW."version_id" END;
  -- s is NULL while a draft version is being deleted (cascade).
  IF s IS NOT NULL AND s <> 'DRAFT' THEN
    RAISE EXCEPTION 'ingredients of a % recipe version cannot be changed', s
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."version_id" <> OLD."version_id" THEN
    RAISE EXCEPTION 'an ingredient cannot move to another version' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER "recipe_ingredients_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "recipe_ingredients"
  FOR EACH ROW EXECUTE FUNCTION "recipe_ingredient_draft_only"();

CREATE TRIGGER "recipe_ingredients_unit_visible" BEFORE INSERT OR UPDATE ON "recipe_ingredients"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('uom_id');
CREATE TRIGGER "recipe_versions_unit_visible" BEFORE INSERT OR UPDATE ON "recipe_versions"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('yield_uom_id');

-- Cost history is append-only.
CREATE TRIGGER "product_standard_costs_append_only"
  BEFORE UPDATE OR DELETE ON "product_standard_costs"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "product_standard_costs_no_truncate"
  BEFORE TRUNCATE ON "product_standard_costs"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "recipe_cost_snapshots_append_only"
  BEFORE UPDATE OR DELETE ON "recipe_cost_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "recipe_cost_snapshots_no_truncate"
  BEFORE TRUNCATE ON "recipe_cost_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_modification"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE, DELETE ON "recipes", "recipe_versions", "recipe_ingredients" TO fa_tenant;
GRANT SELECT, INSERT ON "product_standard_costs", "recipe_cost_snapshots" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recipes', 'recipe_versions', 'recipe_ingredients',
                           'product_standard_costs', 'recipe_cost_snapshots']
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
  ('admin', 'recipes.view'), ('admin', 'recipes.manage'), ('admin', 'recipes.costs.view'),
  ('operations_manager', 'recipes.view'), ('operations_manager', 'recipes.manage'),
  ('operations_manager', 'recipes.costs.view'),
  ('procurement', 'recipes.view'), ('procurement', 'recipes.costs.view'),
  ('warehouse', 'recipes.view'), ('food_safety', 'recipes.view'),
  ('finance', 'recipes.view'), ('finance', 'recipes.costs.view'),
  ('branch_manager', 'recipes.view'),
  ('analyst', 'recipes.view'), ('analyst', 'recipes.costs.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
