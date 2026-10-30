-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PARTIALLY_ORDERED', 'ORDERED', 'REJECTED', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "purchase_requisitions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "RequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "needed_by" DATE,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requisition_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "uom_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "quantity_base" DECIMAL(20,6) NOT NULL,
    "note" TEXT,
    "purchase_order_line_id" UUID,
    "ordered_at" TIMESTAMPTZ(3),

    CONSTRAINT "purchase_requisition_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_requisitions_organization_id_status_idx" ON "purchase_requisitions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "purchase_requisitions_organization_id_warehouse_id_idx" ON "purchase_requisitions"("organization_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisitions_organization_id_id_key" ON "purchase_requisitions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisitions_organization_id_number_key" ON "purchase_requisitions"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisition_lines_organization_id_id_key" ON "purchase_requisition_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisition_lines_organization_id_requisition_id_l_key" ON "purchase_requisition_lines"("organization_id", "requisition_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisition_lines_organization_id_requisition_id_p_key" ON "purchase_requisition_lines"("organization_id", "requisition_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisition_lines_organization_id_purchase_order_l_key" ON "purchase_requisition_lines"("organization_id", "purchase_order_line_id");

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_requisition_id_fkey" FOREIGN KEY ("organization_id", "requisition_id") REFERENCES "purchase_requisitions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_purchase_order__fkey" FOREIGN KEY ("organization_id", "purchase_order_line_id") REFERENCES "purchase_order_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-029) ───

ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_quantities_ck"
  CHECK ("quantity" > 0 AND "quantity_base" > 0 AND "line_no" > 0
         AND (("purchase_order_line_id" IS NULL) = ("ordered_at" IS NULL)));
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_status_ck"
  CHECK (("status" = 'DRAFT' OR "submitted_at" IS NOT NULL OR "status" = 'CANCELLED')
         AND ("status" NOT IN ('REJECTED', 'CLOSED', 'CANCELLED')
              OR ("decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL)));

CREATE TRIGGER "purchase_requisition_lines_unit_visible" BEFORE INSERT OR UPDATE ON "purchase_requisition_lines"
  FOR EACH ROW EXECUTE FUNCTION "assert_unit_visible"('uom_id');

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_requisitions", "purchase_requisition_lines" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_requisitions', 'purchase_requisition_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- ─── New permission for existing organizations' system roles ───
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'purchasing.request'), ('operations_manager', 'purchasing.request'),
  ('procurement', 'purchasing.request'), ('warehouse', 'purchasing.request'),
  ('branch_manager', 'purchasing.request')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
