-- CreateEnum
CREATE TYPE "PosShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PosCashMovementKind" AS ENUM ('PAY_IN', 'PAY_OUT');

-- CreateEnum
CREATE TYPE "PosOrderStatus" AS ENUM ('PAID', 'VOIDED');

-- CreateEnum
CREATE TYPE "PosPaymentMethod" AS ENUM ('CASH', 'CARD');

-- CreateEnum
CREATE TYPE "PosShortfallStatus" AS ENUM ('OPEN', 'POSTED', 'CANCELLED');


-- CreateTable
CREATE TABLE "pos_registers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_shifts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "register_id" UUID NOT NULL,
    "status" "PosShiftStatus" NOT NULL DEFAULT 'OPEN',
    "opening_float" DECIMAL(19,4) NOT NULL,
    "opened_by_user_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_cash" DECIMAL(19,4),
    "counted_cash" DECIMAL(19,4),
    "cash_difference" DECIMAL(19,4),
    "close_note" TEXT,
    "closed_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "pos_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_cash_movements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "kind" "PosCashMovementKind" NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "register_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "channel" "SalesChannel" NOT NULL,
    "status" "PosOrderStatus" NOT NULL DEFAULT 'PAID',
    "ordered_at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "net_amount" DECIMAL(19,4) NOT NULL,
    "tax_amount" DECIMAL(19,4) NOT NULL,
    "gross_amount" DECIMAL(19,4) NOT NULL,
    "cost_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "consumption_doc_id" UUID,
    "refunded_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "note" TEXT,
    "cashier_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "void_reason" TEXT,
    "void_doc_id" UUID,

    CONSTRAINT "pos_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_order_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit_price" DECIMAL(19,4) NOT NULL,
    "price_includes_tax" BOOLEAN NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "tax_code_id" UUID,
    "tax_rate" DECIMAL(7,6),
    "net_amount" DECIMAL(19,4) NOT NULL,
    "tax_amount" DECIMAL(19,4) NOT NULL,
    "gross_amount" DECIMAL(19,4) NOT NULL,
    "refunded_quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,

    CONSTRAINT "pos_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "method" "PosPaymentMethod" NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "tendered" DECIMAL(19,4),
    "change" DECIMAL(19,4),
    "reference" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_refunds" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "method" "PosPaymentMethod" NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "tax_amount" DECIMAL(19,4) NOT NULL,
    "lines" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_consumption_shortfalls" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "status" "PosShortfallStatus" NOT NULL DEFAULT 'OPEN',
    "document_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_consumption_shortfalls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_registers_organization_id_id_key" ON "pos_registers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_registers_organization_id_code_key" ON "pos_registers"("organization_id", "code");

-- CreateIndex
CREATE INDEX "pos_shifts_organization_id_register_id_idx" ON "pos_shifts"("organization_id", "register_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_shifts_organization_id_id_key" ON "pos_shifts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_shifts_organization_id_number_key" ON "pos_shifts"("organization_id", "number");

-- CreateIndex
CREATE INDEX "pos_cash_movements_organization_id_shift_id_idx" ON "pos_cash_movements"("organization_id", "shift_id");

-- CreateIndex
CREATE INDEX "pos_orders_organization_id_shift_id_idx" ON "pos_orders"("organization_id", "shift_id");

-- CreateIndex
CREATE INDEX "pos_orders_organization_id_business_date_idx" ON "pos_orders"("organization_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "pos_orders_organization_id_id_key" ON "pos_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_orders_organization_id_number_key" ON "pos_orders"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "pos_order_lines_organization_id_id_key" ON "pos_order_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_order_lines_organization_id_order_id_line_no_key" ON "pos_order_lines"("organization_id", "order_id", "line_no");

-- CreateIndex
CREATE INDEX "pos_payments_organization_id_order_id_idx" ON "pos_payments"("organization_id", "order_id");

-- CreateIndex
CREATE INDEX "pos_refunds_organization_id_order_id_idx" ON "pos_refunds"("organization_id", "order_id");

-- CreateIndex
CREATE INDEX "pos_refunds_organization_id_shift_id_idx" ON "pos_refunds"("organization_id", "shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_refunds_organization_id_number_key" ON "pos_refunds"("organization_id", "number");

-- CreateIndex
CREATE INDEX "pos_consumption_shortfalls_organization_id_status_idx" ON "pos_consumption_shortfalls"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_organization_id_register_id_fkey" FOREIGN KEY ("organization_id", "register_id") REFERENCES "pos_registers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "pos_shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_organization_id_register_id_fkey" FOREIGN KEY ("organization_id", "register_id") REFERENCES "pos_registers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "pos_shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_organization_id_order_id_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "pos_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_organization_id_order_id_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "pos_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_organization_id_order_id_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "pos_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "pos_shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_consumption_shortfalls" ADD CONSTRAINT "pos_consumption_shortfalls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_consumption_shortfalls" ADD CONSTRAINT "pos_consumption_shortfalls_organization_id_order_id_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "pos_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_consumption_shortfalls" ADD CONSTRAINT "pos_consumption_shortfalls_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Rules (ADR-059) ───

ALTER TABLE "pos_registers" ADD CONSTRAINT "pos_registers_values_ck"
  CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' AND length("name") BETWEEN 1 AND 80);
-- One open shift per register.
CREATE UNIQUE INDEX "pos_shifts_one_open" ON "pos_shifts" ("organization_id", "register_id") WHERE "status" = 'OPEN';
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_values_ck"
  CHECK ("opening_float" >= 0
     AND (("status" = 'CLOSED') = ("closed_at" IS NOT NULL))
     AND ("status" = 'OPEN' OR ("counted_cash" IS NOT NULL AND "expected_cash" IS NOT NULL
          AND "cash_difference" = "counted_cash" - "expected_cash" AND "closed_by_user_id" IS NOT NULL)));
ALTER TABLE "pos_cash_movements" ADD CONSTRAINT "pos_cash_movements_values_ck"
  CHECK ("amount" > 0 AND length("reason") BETWEEN 1 AND 300);
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_values_ck"
  CHECK ("gross_amount" = "net_amount" + "tax_amount" AND "net_amount" >= 0 AND "tax_amount" >= 0
     AND "refunded_amount" >= 0 AND "refunded_amount" <= "gross_amount" AND "cost_amount" >= 0
     AND (("status" = 'VOIDED') = ("voided_at" IS NOT NULL))
     AND ("status" = 'PAID' OR ("void_reason" IS NOT NULL AND "voided_by_user_id" IS NOT NULL AND "refunded_amount" = 0)));
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_values_ck"
  CHECK ("line_no" > 0 AND "quantity" > 0 AND "unit_price" >= 0
     AND "gross_amount" = "net_amount" + "tax_amount"
     AND "refunded_quantity" >= 0 AND "refunded_quantity" <= "quantity");
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_values_ck"
  CHECK ("amount" > 0
     AND ("method" = 'CASH' OR ("tendered" IS NULL AND "change" IS NULL))
     AND ("tendered" IS NULL OR ("tendered" >= "amount" AND "change" = "tendered" - "amount")));
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_values_ck"
  CHECK ("amount" > 0 AND "tax_amount" >= 0 AND "tax_amount" <= "amount" AND length("reason") BETWEEN 1 AND 500);
ALTER TABLE "pos_consumption_shortfalls" ADD CONSTRAINT "pos_shortfalls_values_ck"
  CHECK ("quantity" > 0 AND (("status" = 'OPEN') = ("resolved_at" IS NULL))
     AND ("status" <> 'POSTED' OR "document_id" IS NOT NULL));

-- Sales records are fixed: an order may only be voided or refunded; lines only refunded;
-- payments, refunds and cash movements are insert-only.
CREATE FUNCTION "pos_fixed_except"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE free text[] := TG_ARGV::text[];
BEGIN
  IF (to_jsonb(NEW) - free) <> (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION '% rows can only change % ', TG_TABLE_NAME, free USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pos_orders_fixed" BEFORE UPDATE ON "pos_orders"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('status', 'voided_at', 'voided_by_user_id', 'void_reason', 'void_doc_id', 'refunded_amount', 'cost_amount', 'consumption_doc_id');
CREATE TRIGGER "pos_order_lines_fixed" BEFORE UPDATE ON "pos_order_lines"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('refunded_quantity');
CREATE TRIGGER "pos_shifts_fixed" BEFORE UPDATE ON "pos_shifts"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('status', 'expected_cash', 'counted_cash', 'cash_difference', 'close_note', 'closed_by_user_id', 'closed_at');

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "pos_registers", "pos_shifts", "pos_orders", "pos_order_lines", "pos_consumption_shortfalls" TO fa_tenant;
GRANT SELECT, INSERT ON "pos_cash_movements", "pos_payments", "pos_refunds" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_registers', 'pos_shifts', 'pos_cash_movements', 'pos_orders', 'pos_order_lines',
                           'pos_payments', 'pos_refunds', 'pos_consumption_shortfalls']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- The Cashier system role for existing organizations (ADR-059).
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.
INSERT INTO "roles" ("id", "organization_id", "key", "name", "description", "is_system", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", 'cashier', 'Cashier',
       'Sells at the point of sale and runs their own shift (usually granted at branch scope).', true, now(), now()
FROM "organizations" o
ON CONFLICT ("organization_id", "key") DO NOTHING;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'pos.sell'), ('admin', 'pos.void'), ('admin', 'pos.refund'), ('admin', 'pos.manage'), ('admin', 'pos.view'),
  ('operations_manager', 'pos.sell'), ('operations_manager', 'pos.void'), ('operations_manager', 'pos.refund'),
  ('operations_manager', 'pos.manage'), ('operations_manager', 'pos.view'),
  ('branch_manager', 'pos.sell'), ('branch_manager', 'pos.void'), ('branch_manager', 'pos.refund'), ('branch_manager', 'pos.view'),
  ('finance', 'pos.view'), ('analyst', 'pos.view'),
  ('cashier', 'pos.sell'), ('cashier', 'menu.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
