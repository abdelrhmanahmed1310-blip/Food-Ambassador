-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('PLANNED', 'COMPLETED', 'REVERSED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "InventoryDocumentType" ADD VALUE 'PRODUCTION';

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN     "output_product_id" UUID;

-- CreateTable
CREATE TABLE "production_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "recipe_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "output_product_id" UUID NOT NULL,
    "planned_quantity" DECIMAL(20,6) NOT NULL,
    "planned_uom_id" UUID NOT NULL,
    "planned_for" DATE,
    "status" "ProductionStatus" NOT NULL DEFAULT 'PLANNED',
    "produced_quantity_base" DECIMAL(20,6),
    "output_lot_id" UUID,
    "cost" DECIMAL(19,4),
    "document_id" UUID,
    "reversal_document_id" UUID,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_user_id" UUID,
    "close_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_orders_organization_id_warehouse_id_status_idx" ON "production_orders"("organization_id", "warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_organization_id_id_key" ON "production_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_organization_id_number_key" ON "production_orders"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_organization_id_document_id_key" ON "production_orders"("organization_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_organization_id_reversal_document_id_key" ON "production_orders"("organization_id", "reversal_document_id");

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_organization_id_output_product_id_fkey" FOREIGN KEY ("organization_id", "output_product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_organization_id_recipe_id_fkey" FOREIGN KEY ("organization_id", "recipe_id") REFERENCES "recipes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_organization_id_version_id_fkey" FOREIGN KEY ("organization_id", "version_id") REFERENCES "recipe_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_organization_id_output_product_id_fkey" FOREIGN KEY ("organization_id", "output_product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_planned_uom_id_fkey" FOREIGN KEY ("planned_uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_organization_id_output_product_id_output_fkey" FOREIGN KEY ("organization_id", "output_product_id", "output_lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_organization_id_reversal_document_id_fkey" FOREIGN KEY ("organization_id", "reversal_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-045) ───

ALTER TABLE "recipes" ADD CONSTRAINT "recipes_output_product_ck"
  CHECK ("output_product_id" IS NULL OR "type" = 'PREPARATION');

ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_values_ck"
  CHECK ("planned_quantity" > 0
     AND (("status" IN ('COMPLETED', 'REVERSED')) = ("document_id" IS NOT NULL))
     AND (("status" IN ('COMPLETED', 'REVERSED')) = ("completed_at" IS NOT NULL))
     AND ("status" NOT IN ('COMPLETED', 'REVERSED') OR ("produced_quantity_base" > 0 AND "cost" IS NOT NULL))
     AND (("status" = 'REVERSED') = ("reversal_document_id" IS NOT NULL))
     AND (("status" IN ('REVERSED', 'CANCELLED')) = ("closed_at" IS NOT NULL)));

-- Status moves PLANNED → COMPLETED | CANCELLED and COMPLETED → REVERSED; the plan is fixed once completed.
CREATE FUNCTION "production_order_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = NEW."status" AND OLD."status" = 'PLANNED' THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD."status" = 'PLANNED' AND NEW."status" IN ('COMPLETED', 'CANCELLED'))
       OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'REVERSED'))
     OR NEW."recipe_id" <> OLD."recipe_id" OR NEW."version_id" <> OLD."version_id"
     OR NEW."warehouse_id" <> OLD."warehouse_id" OR NEW."output_product_id" <> OLD."output_product_id"
     OR (OLD."status" = 'COMPLETED' AND (NEW."planned_quantity" <> OLD."planned_quantity"
         OR NEW."produced_quantity_base" IS DISTINCT FROM OLD."produced_quantity_base"
         OR NEW."cost" IS DISTINCT FROM OLD."cost" OR NEW."document_id" IS DISTINCT FROM OLD."document_id")) THEN
    RAISE EXCEPTION 'production order cannot change from % to %', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "production_orders_transition" BEFORE UPDATE ON "production_orders"
  FOR EACH ROW EXECUTE FUNCTION "production_order_transition"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "production_orders" TO fa_tenant;
ALTER TABLE "production_orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "production_orders"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

-- ─── New permissions for existing organizations' system roles ───
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'production.view'), ('admin', 'production.manage'),
  ('operations_manager', 'production.view'), ('operations_manager', 'production.manage'),
  ('branch_manager', 'production.view'), ('branch_manager', 'production.manage'),
  ('warehouse', 'production.view'), ('food_safety', 'production.view'),
  ('procurement', 'production.view'), ('analyst', 'production.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
