-- Subcategories (ADR-134): a product category may have a parent, at most three levels deep.
ALTER TABLE "product_categories" ADD COLUMN "parent_id" UUID;
CREATE INDEX "product_categories_organization_id_parent_id_idx" ON "product_categories"("organization_id", "parent_id");
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_organization_id_parent_id_fkey" FOREIGN KEY ("organization_id", "parent_id") REFERENCES "product_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- Defence in depth for what the service checks first: no loops, and a category
-- never sits below the third level (its parent chain has at most two ancestors).
CREATE FUNCTION product_categories_tree_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ancestors int;
  loops boolean;
BEGIN
  IF NEW."parent_id" IS NULL THEN
    RETURN NEW;
  END IF;
  WITH RECURSIVE up AS (
    SELECT c."id", c."parent_id", 1 AS n FROM "product_categories" c
      WHERE c."organization_id" = NEW."organization_id" AND c."id" = NEW."parent_id"
    UNION ALL
    SELECT c."id", c."parent_id", up.n + 1 FROM "product_categories" c
      JOIN up ON c."id" = up."parent_id" AND c."organization_id" = NEW."organization_id"
      WHERE up.n < 10
  )
  SELECT count(*), bool_or(up."id" = NEW."id") INTO ancestors, loops FROM up;
  IF loops THEN
    RAISE EXCEPTION 'A category cannot be placed under its own subcategory' USING ERRCODE = 'check_violation';
  END IF;
  IF ancestors > 2 THEN
    RAISE EXCEPTION 'Categories are at most three levels deep' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "product_categories_tree"
  BEFORE INSERT OR UPDATE OF "parent_id" ON "product_categories"
  FOR EACH ROW EXECUTE FUNCTION product_categories_tree_check();
