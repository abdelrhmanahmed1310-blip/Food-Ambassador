-- M3a: moving weighted average stock valuation (DECISIONS.md ADR-021).

-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('ENTERED', 'AVERAGE', 'TRANSFER', 'RESTORED', 'NONE');

-- AlterEnum
ALTER TYPE "InventoryDocumentType" ADD VALUE 'REVALUATION';

-- AlterTable
-- Added with temporary defaults, backfilled below, then the defaults are dropped.
ALTER TABLE "inventory_ledger_entries" ADD COLUMN     "cost_source" "CostSource" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "value_delta" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "stock_valuations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "total_value" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "average_unit_cost" DECIMAL(20,6),
    "cost_missing" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_revaluations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "previous_unit_cost" DECIMAL(20,6),
    "new_unit_cost" DECIMAL(20,6) NOT NULL,
    "previous_value" DECIMAL(19,4) NOT NULL,
    "new_value" DECIMAL(19,4) NOT NULL,
    "value_delta" DECIMAL(19,4) NOT NULL,
    "previous_cost_missing" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_revaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_valuations_organization_id_product_id_idx" ON "stock_valuations"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_valuations_organization_id_id_key" ON "stock_valuations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_valuations_organization_id_warehouse_id_product_id_key" ON "stock_valuations"("organization_id", "warehouse_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_revaluations_organization_id_product_id_warehouse_id_idx" ON "stock_revaluations"("organization_id", "product_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_revaluations_organization_id_document_id_key" ON "stock_revaluations"("organization_id", "document_id");

-- AddForeignKey
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_revaluations" ADD CONSTRAINT "stock_revaluations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_revaluations" ADD CONSTRAINT "stock_revaluations_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "inventory_documents"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_revaluations" ADD CONSTRAINT "stock_revaluations_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_revaluations" ADD CONSTRAINT "stock_revaluations_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Constraints (ADR-021) ───

ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_amounts_ck"
  CHECK ("quantity" >= 0 AND "total_value" >= 0 AND ("quantity" > 0 OR "total_value" = 0)
         AND ("average_unit_cost" IS NULL OR "average_unit_cost" >= 0));
ALTER TABLE "stock_revaluations" ADD CONSTRAINT "stock_revaluations_amounts_ck"
  CHECK ("quantity" >= 0 AND "new_unit_cost" >= 0 AND "previous_value" >= 0 AND "new_value" >= 0
         AND "value_delta" = "new_value" - "previous_value");

-- Revaluations are history: append-only like the ledger.
CREATE TRIGGER "stock_revaluations_append_only"
  BEFORE UPDATE OR DELETE ON "stock_revaluations"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();
CREATE TRIGGER "stock_revaluations_no_truncate"
  BEFORE TRUNCATE ON "stock_revaluations"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_modification"();

-- ─── Backfill: replay the existing ledger with the moving average rules ───
-- Same rules as src/modules/inventory/valuation.ts. Documents are replayed in
-- creation order (UUIDv7); inside a document, outbound entries first so that
-- the inbound leg of a transfer or status change can take the outbound cost.

ALTER TABLE "inventory_ledger_entries" DISABLE TRIGGER "inventory_ledger_entries_append_only";

DO $$
DECLARE
  e record;
  v record;
  pair_id uuid; pair_value numeric; pair_unit numeric;
  orig_id uuid; orig_type "MovementType"; orig_value numeric; orig_unit numeric;
  q numeric; val numeric; unit numeric; src "CostSource";
  new_q numeric; new_v numeric; missing boolean;
  current_doc uuid := NULL;
  doc_out_missing boolean := false;
BEGIN
  FOR e IN
    SELECT le.*, d."type" AS doc_type
    FROM "inventory_ledger_entries" le
    JOIN "inventory_documents" d ON d."organization_id" = le."organization_id" AND d."id" = le."document_id"
    ORDER BY le."document_id", (le."quantity_delta" > 0), le."id"
  LOOP
    IF current_doc IS DISTINCT FROM e."document_id" THEN
      current_doc := e."document_id";
      doc_out_missing := false;
    END IF;

    INSERT INTO "stock_valuations" ("id", "organization_id", "warehouse_id", "product_id", "updated_at")
    VALUES (gen_random_uuid(), e."organization_id", e."warehouse_id", e."product_id", now())
    ON CONFLICT ("organization_id", "warehouse_id", "product_id") DO NOTHING;
    SELECT * INTO v FROM "stock_valuations"
    WHERE "organization_id" = e."organization_id" AND "warehouse_id" = e."warehouse_id"
      AND "product_id" = e."product_id";

    q := e."quantity_delta";
    missing := v."cost_missing";
    IF q < 0 THEN
      IF v."quantity" <= 0 THEN
        RAISE EXCEPTION 'valuation backfill: outbound entry % without stock', e."id";
      END IF;
      unit := round(v."total_value" / v."quantity", 6);
      IF -q >= v."quantity" THEN val := -v."total_value";
      ELSE val := -round(-q * v."total_value" / v."quantity", 4);
      END IF;
      src := 'AVERAGE';
      doc_out_missing := doc_out_missing OR v."cost_missing";
    ELSE
      pair_id := NULL;
      orig_id := NULL;
      IF e."reverses_entry_id" IS NOT NULL THEN
        SELECT "id", "movement_type", "value_delta", "unit_cost"
        INTO orig_id, orig_type, orig_value, orig_unit
        FROM "inventory_ledger_entries"
        WHERE "organization_id" = e."organization_id" AND "id" = e."reverses_entry_id";
      END IF;
      IF e."movement_type" IN ('TRANSFER_IN', 'STATUS_CHANGE')
         OR (orig_id IS NOT NULL AND orig_type IN ('TRANSFER_OUT', 'STATUS_CHANGE')) THEN
        SELECT "id", "value_delta", "unit_cost" INTO pair_id, pair_value, pair_unit
        FROM "inventory_ledger_entries"
        WHERE "organization_id" = e."organization_id" AND "document_id" = e."document_id"
          AND "product_id" = e."product_id" AND "lot_id" IS NOT DISTINCT FROM e."lot_id"
          AND "quantity_delta" = -q
        ORDER BY "id" LIMIT 1;
      END IF;
      IF pair_id IS NOT NULL THEN
        val := -pair_value; unit := pair_unit; src := 'TRANSFER';
        missing := missing OR doc_out_missing;
      ELSIF orig_id IS NOT NULL THEN
        val := -orig_value; unit := orig_unit; src := 'RESTORED';
      ELSIF e."unit_cost" IS NOT NULL THEN
        unit := e."unit_cost"; val := round(q * unit, 4); src := 'ENTERED';
      ELSIF v."cost_missing" THEN
        -- The average is not reliable while uncosted units are on hand.
        unit := NULL; val := 0; src := 'NONE';
      ELSIF v."quantity" > 0 THEN
        unit := round(v."total_value" / v."quantity", 6);
        val := round(q * v."total_value" / v."quantity", 4); src := 'AVERAGE';
      ELSIF v."average_unit_cost" IS NOT NULL THEN
        unit := v."average_unit_cost"; val := round(q * unit, 4); src := 'AVERAGE';
      ELSE
        unit := NULL; val := 0; src := 'NONE'; missing := true;
      END IF;
    END IF;

    UPDATE "inventory_ledger_entries"
    SET "unit_cost" = unit, "value_delta" = val, "cost_source" = src
    WHERE "id" = e."id";

    new_q := v."quantity" + q;
    new_v := CASE WHEN new_q = 0 THEN 0 ELSE v."total_value" + val END;
    UPDATE "stock_valuations"
    SET "quantity" = new_q,
        "total_value" = new_v,
        "average_unit_cost" = CASE WHEN new_q > 0 AND NOT missing THEN round(new_v / new_q, 6)
                                   ELSE v."average_unit_cost" END,
        "cost_missing" = CASE WHEN new_q = 0 THEN false ELSE missing END,
        "updated_at" = now()
    WHERE "id" = v."id";
  END LOOP;

  -- The replay must agree with the balance projection.
  IF EXISTS (
    SELECT 1
    FROM "stock_valuations" sv
    FULL JOIN (
      SELECT "organization_id", "warehouse_id", "product_id", sum("on_hand_quantity") AS qty
      FROM "stock_balances" GROUP BY 1, 2, 3
    ) b USING ("organization_id", "warehouse_id", "product_id")
    WHERE coalesce(sv."quantity", 0) <> coalesce(b.qty, 0)
  ) THEN
    RAISE EXCEPTION 'valuation backfill: quantities do not match stock_balances';
  END IF;
END
$$;

ALTER TABLE "inventory_ledger_entries" ENABLE TRIGGER "inventory_ledger_entries_append_only";

ALTER TABLE "inventory_ledger_entries" ALTER COLUMN "cost_source" DROP DEFAULT;
ALTER TABLE "inventory_ledger_entries" ALTER COLUMN "value_delta" DROP DEFAULT;

-- Entry costing invariants: an unknown cost carries no value; value moves with quantity.
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_value_ck"
  CHECK ((("cost_source" = 'NONE') = ("unit_cost" IS NULL))
         AND ("cost_source" <> 'NONE' OR "value_delta" = 0)
         AND "value_delta" * "quantity_delta" >= 0);

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "stock_valuations" TO fa_tenant;
GRANT SELECT, INSERT ON "stock_revaluations" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_valuations', 'stock_revaluations']
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
  ('admin', 'inventory.valuation.view'), ('admin', 'inventory.valuation.revalue'),
  ('operations_manager', 'inventory.valuation.view'), ('operations_manager', 'inventory.valuation.revalue'),
  ('procurement', 'inventory.valuation.view'),
  ('finance', 'inventory.valuation.view'), ('finance', 'inventory.valuation.revalue'),
  ('branch_manager', 'inventory.valuation.view'),
  ('analyst', 'inventory.valuation.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
