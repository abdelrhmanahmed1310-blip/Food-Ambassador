-- CreateEnum
CREATE TYPE "RecallStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "RecallOutcome" AS ENUM ('DISPOSED', 'RELEASED');

-- CreateEnum
CREATE TYPE "RecallDocumentKind" AS ENUM ('HOLD', 'DISPOSAL');

-- CreateTable
CREATE TABLE "recalls" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RecallStatus" NOT NULL DEFAULT 'DRAFT',
    "outcome" "RecallOutcome",
    "created_by_user_id" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "activated_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_user_id" UUID,
    "close_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_lots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recall_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recall_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_stock" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recall_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID,
    "stock_status" "StockStatus" NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "recall_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recall_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "kind" "RecallDocumentKind" NOT NULL,

    CONSTRAINT "recall_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recalls_organization_id_status_idx" ON "recalls"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recalls_organization_id_id_key" ON "recalls"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recalls_organization_id_number_key" ON "recalls"("organization_id", "number");

-- CreateIndex
CREATE INDEX "recall_lots_organization_id_lot_id_idx" ON "recall_lots"("organization_id", "lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "recall_lots_organization_id_id_key" ON "recall_lots"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recall_lots_organization_id_recall_id_lot_id_key" ON "recall_lots"("organization_id", "recall_id", "lot_id");

-- CreateIndex
CREATE INDEX "recall_stock_organization_id_recall_id_idx" ON "recall_stock"("organization_id", "recall_id");

-- CreateIndex
CREATE UNIQUE INDEX "recall_stock_organization_id_id_key" ON "recall_stock"("organization_id", "id");

-- CreateIndex
CREATE INDEX "recall_documents_organization_id_recall_id_idx" ON "recall_documents"("organization_id", "recall_id");

-- CreateIndex
CREATE UNIQUE INDEX "recall_documents_organization_id_id_key" ON "recall_documents"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recall_documents_organization_id_document_id_key" ON "recall_documents"("organization_id", "document_id");

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_lots" ADD CONSTRAINT "recall_lots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_lots" ADD CONSTRAINT "recall_lots_organization_id_recall_id_fkey" FOREIGN KEY ("organization_id", "recall_id") REFERENCES "recalls"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_lots" ADD CONSTRAINT "recall_lots_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_stock" ADD CONSTRAINT "recall_stock_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_stock" ADD CONSTRAINT "recall_stock_organization_id_recall_id_fkey" FOREIGN KEY ("organization_id", "recall_id") REFERENCES "recalls"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_stock" ADD CONSTRAINT "recall_stock_organization_id_product_id_lot_id_fkey" FOREIGN KEY ("organization_id", "product_id", "lot_id") REFERENCES "inventory_lots"("organization_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_stock" ADD CONSTRAINT "recall_stock_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_documents" ADD CONSTRAINT "recall_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_documents" ADD CONSTRAINT "recall_documents_organization_id_recall_id_fkey" FOREIGN KEY ("organization_id", "recall_id") REFERENCES "recalls"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_documents" ADD CONSTRAINT "recall_documents_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-034) ───

ALTER TABLE "recalls" ADD CONSTRAINT "recalls_status_ck"
  CHECK (("status" = 'DRAFT' AND "activated_at" IS NULL AND "closed_at" IS NULL AND "outcome" IS NULL)
      OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "closed_at" IS NULL AND "outcome" IS NULL)
      OR ("status" = 'CLOSED' AND "closed_at" IS NOT NULL
          AND (("activated_at" IS NULL) = ("outcome" IS NULL))));
ALTER TABLE "recall_stock" ADD CONSTRAINT "recall_stock_quantity_ck" CHECK ("quantity" > 0);

-- Snapshots and document links are append-only.
CREATE TRIGGER "recall_stock_append_only" BEFORE UPDATE OR DELETE ON "recall_stock"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "recall_documents_append_only" BEFORE UPDATE OR DELETE ON "recall_documents"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE, DELETE ON "recalls", "recall_lots" TO fa_tenant;
GRANT SELECT, INSERT ON "recall_stock", "recall_documents" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recalls', 'recall_lots', 'recall_stock', 'recall_documents']
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
  ('admin', 'traceability.view'), ('admin', 'recalls.manage'),
  ('operations_manager', 'traceability.view'), ('operations_manager', 'recalls.manage'),
  ('food_safety', 'traceability.view'), ('food_safety', 'recalls.manage'),
  ('procurement', 'traceability.view'), ('warehouse', 'traceability.view'),
  ('branch_manager', 'traceability.view'), ('analyst', 'traceability.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
