-- AlterTable
ALTER TABLE "recipe_versions" ADD COLUMN     "method" TEXT;

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN     "target_food_cost_fraction" DECIMAL(7,6);

-- CreateTable
CREATE TABLE "recipe_prices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "price" DECIMAL(19,4) NOT NULL,
    "effective_from" DATE NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_settings" (
    "organization_id" UUID NOT NULL,
    "target_food_cost_fraction" DECIMAL(7,6),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recipe_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipe_prices_organization_id_id_key" ON "recipe_prices"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_prices_organization_id_recipe_id_effective_from_key" ON "recipe_prices"("organization_id", "recipe_id", "effective_from");

-- AddForeignKey
ALTER TABLE "recipe_prices" ADD CONSTRAINT "recipe_prices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_prices" ADD CONSTRAINT "recipe_prices_organization_id_recipe_id_fkey" FOREIGN KEY ("organization_id", "recipe_id") REFERENCES "recipes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_settings" ADD CONSTRAINT "recipe_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-032) ───

ALTER TABLE "recipe_prices" ADD CONSTRAINT "recipe_prices_price_ck" CHECK ("price" > 0);
ALTER TABLE "recipe_settings" ADD CONSTRAINT "recipe_settings_target_ck"
  CHECK ("target_food_cost_fraction" IS NULL
         OR ("target_food_cost_fraction" > 0 AND "target_food_cost_fraction" < 1));
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_target_ck"
  CHECK ("target_food_cost_fraction" IS NULL
         OR ("target_food_cost_fraction" > 0 AND "target_food_cost_fraction" < 1));

-- The method is version content too: fixed once the version is not a draft.
CREATE OR REPLACE FUNCTION "recipe_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND NEW."method" IS NOT DISTINCT FROM OLD."method"
     AND NEW."activated_at" = OLD."activated_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'recipe version % is % and cannot be changed', OLD."id", OLD."status"
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Price history is append-only.
CREATE TRIGGER "recipe_prices_append_only"
  BEFORE UPDATE OR DELETE ON "recipe_prices"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "recipe_prices_no_truncate"
  BEFORE TRUNCATE ON "recipe_prices"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_modification"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT ON "recipe_prices" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "recipe_settings" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recipe_prices', 'recipe_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
