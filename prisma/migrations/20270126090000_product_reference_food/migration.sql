-- Product ↔ library food link (ADR-136): the link moves to the product, so many
-- products (e.g. two pack sizes of rice) can share one generic library food.
ALTER TABLE "products" ADD COLUMN "reference_food_id" UUID;
CREATE INDEX "products_organization_id_reference_food_id_idx" ON "products"("organization_id", "reference_food_id");
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_reference_food_id_fkey" FOREIGN KEY ("organization_id", "reference_food_id") REFERENCES "reference_foods"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Carry existing links over. Where several records were linked to one product,
-- keep the one the recipe panel used: verified first, then the most recently updated.
UPDATE "products" p SET "reference_food_id" = pick."id"
FROM (
  SELECT DISTINCT ON (f."organization_id", f."linked_product_id")
    f."organization_id", f."linked_product_id", f."id"
  FROM "reference_foods" f
  WHERE f."linked_product_id" IS NOT NULL AND f."archived_at" IS NULL
  ORDER BY f."organization_id", f."linked_product_id", f."verified_at" DESC NULLS LAST, f."updated_at" DESC
) pick
WHERE p."organization_id" = pick."organization_id" AND p."id" = pick."linked_product_id";

ALTER TABLE "reference_foods" DROP CONSTRAINT "reference_foods_organization_id_linked_product_id_fkey";
ALTER TABLE "reference_foods" DROP COLUMN "linked_product_id";
