-- CreateEnum
CREATE TYPE "SalesImportStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "SalesItemType" AS ENUM ('RECIPE', 'PRODUCT');

-- AlterEnum
ALTER TYPE "InventoryDocumentType" ADD VALUE 'CONSUMPTION';

-- CreateTable
CREATE TABLE "sales_imports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "file_name" TEXT,
    "status" "SalesImportStatus" NOT NULL DEFAULT 'POSTED',
    "line_count" INTEGER NOT NULL,
    "skipped_count" INTEGER NOT NULL,
    "net_amount" DECIMAL(19,4),
    "cost_amount" DECIMAL(19,4) NOT NULL,
    "document_id" UUID NOT NULL,
    "reversal_document_id" UUID,
    "posted_by_user_id" UUID NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_user_id" UUID,
    "reversal_reason" TEXT,

    CONSTRAINT "sales_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_no" INTEGER NOT NULL,
    "external_id" TEXT NOT NULL,
    "sold_on" DATE NOT NULL,
    "channel" TEXT,
    "item_type" "SalesItemType" NOT NULL,
    "recipe_id" UUID,
    "recipe_version_id" UUID,
    "product_id" UUID,
    "quantity" DECIMAL(20,6) NOT NULL,
    "net_amount" DECIMAL(19,4),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sales_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_imports_organization_id_posted_at_idx" ON "sales_imports"("organization_id", "posted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sales_imports_organization_id_id_key" ON "sales_imports"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_imports_organization_id_number_key" ON "sales_imports"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_imports_organization_id_document_id_key" ON "sales_imports"("organization_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_imports_organization_id_reversal_document_id_key" ON "sales_imports"("organization_id", "reversal_document_id");

-- CreateIndex
CREATE INDEX "sales_lines_organization_id_import_id_idx" ON "sales_lines"("organization_id", "import_id");

-- CreateIndex
CREATE INDEX "sales_lines_organization_id_sold_on_idx" ON "sales_lines"("organization_id", "sold_on");

-- CreateIndex
CREATE UNIQUE INDEX "sales_lines_organization_id_id_key" ON "sales_lines"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_organization_id_reversal_document_id_fkey" FOREIGN KEY ("organization_id", "reversal_document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_organization_id_import_id_fkey" FOREIGN KEY ("organization_id", "import_id") REFERENCES "sales_imports"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_organization_id_recipe_id_fkey" FOREIGN KEY ("organization_id", "recipe_id") REFERENCES "recipes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_organization_id_recipe_version_id_fkey" FOREIGN KEY ("organization_id", "recipe_version_id") REFERENCES "recipe_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-036) ───

ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_item_ck"
  CHECK ("quantity" > 0 AND "row_no" > 0
         AND (("item_type" = 'RECIPE' AND "recipe_id" IS NOT NULL AND "recipe_version_id" IS NOT NULL AND "product_id" IS NULL)
           OR ("item_type" = 'PRODUCT' AND "product_id" IS NOT NULL AND "recipe_id" IS NULL AND "recipe_version_id" IS NULL)));
ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_status_ck"
  CHECK ("line_count" >= 0 AND "skipped_count" >= 0 AND "cost_amount" >= 0
         AND (("status" = 'REVERSED') = ("reversal_document_id" IS NOT NULL))
         AND (("status" = 'REVERSED') = ("reversed_at" IS NOT NULL)));

-- An external id can be posted once at a time; a reversed import frees it.
CREATE UNIQUE INDEX "sales_lines_active_external_id" ON "sales_lines" ("organization_id", "external_id")
  WHERE "active";

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "sales_imports" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ("active") ON "sales_lines" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_imports', 'sales_lines']
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
  ('admin', 'sales.view'), ('admin', 'sales.import'),
  ('operations_manager', 'sales.view'), ('operations_manager', 'sales.import'),
  ('branch_manager', 'sales.view'), ('branch_manager', 'sales.import'),
  ('finance', 'sales.view'), ('analyst', 'sales.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
