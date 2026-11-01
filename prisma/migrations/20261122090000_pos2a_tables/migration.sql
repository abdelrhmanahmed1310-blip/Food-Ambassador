-- CreateEnum
CREATE TYPE "PosTabStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED', 'MERGED');

-- CreateEnum
CREATE TYPE "PosTabLineStatus" AS ENUM ('PENDING', 'SENT', 'VOIDED');

-- DropIndex

-- AlterTable
ALTER TABLE "pos_order_lines" ADD COLUMN     "tab_line_id" UUID;

-- AlterTable
ALTER TABLE "pos_orders" ADD COLUMN     "tab_id" UUID;

-- CreateTable
CREATE TABLE "pos_floors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_tables" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "floor_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "grid_x" INTEGER NOT NULL,
    "grid_y" INTEGER NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_tabs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "table_id" UUID,
    "label" TEXT,
    "guests" INTEGER NOT NULL,
    "channel" "SalesChannel" NOT NULL DEFAULT 'DINE_IN',
    "status" "PosTabStatus" NOT NULL DEFAULT 'OPEN',
    "waiter_user_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "merged_into_tab_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "pos_tabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_tab_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tab_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "option_ids" UUID[],
    "option_names" JSONB NOT NULL,
    "seat" INTEGER,
    "course" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "hold" BOOLEAN NOT NULL DEFAULT false,
    "status" "PosTabLineStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMPTZ(3),
    "sent_by_user_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "void_reason" TEXT,
    "waste_doc_id" UUID,
    "paid_quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_tab_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_floors_organization_id_id_key" ON "pos_floors"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_floors_organization_id_branch_id_name_key" ON "pos_floors"("organization_id", "branch_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tables_organization_id_id_key" ON "pos_tables"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tables_organization_id_branch_id_code_key" ON "pos_tables"("organization_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "pos_tabs_organization_id_branch_id_status_idx" ON "pos_tabs"("organization_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tabs_organization_id_id_key" ON "pos_tabs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tabs_organization_id_number_key" ON "pos_tabs"("organization_id", "number");

-- CreateIndex
CREATE INDEX "pos_tab_lines_organization_id_tab_id_idx" ON "pos_tab_lines"("organization_id", "tab_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tab_lines_organization_id_id_key" ON "pos_tab_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tab_lines_tab_id_line_no_key" ON "pos_tab_lines"("tab_id", "line_no");

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_organization_id_tab_id_fkey" FOREIGN KEY ("organization_id", "tab_id") REFERENCES "pos_tabs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_floors" ADD CONSTRAINT "pos_floors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_floors" ADD CONSTRAINT "pos_floors_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_floors" ADD CONSTRAINT "pos_floors_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tables" ADD CONSTRAINT "pos_tables_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tables" ADD CONSTRAINT "pos_tables_organization_id_floor_id_fkey" FOREIGN KEY ("organization_id", "floor_id") REFERENCES "pos_floors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tables" ADD CONSTRAINT "pos_tables_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tabs" ADD CONSTRAINT "pos_tabs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tabs" ADD CONSTRAINT "pos_tabs_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tabs" ADD CONSTRAINT "pos_tabs_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tabs" ADD CONSTRAINT "pos_tabs_organization_id_table_id_fkey" FOREIGN KEY ("organization_id", "table_id") REFERENCES "pos_tables"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tab_lines" ADD CONSTRAINT "pos_tab_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tab_lines" ADD CONSTRAINT "pos_tab_lines_organization_id_tab_id_fkey" FOREIGN KEY ("organization_id", "tab_id") REFERENCES "pos_tabs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tab_lines" ADD CONSTRAINT "pos_tab_lines_organization_id_menu_item_id_fkey" FOREIGN KEY ("organization_id", "menu_item_id") REFERENCES "menu_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules, access and row-level security (ADR-062) ───

ALTER TABLE "pos_floors" ADD CONSTRAINT "pos_floors_values_ck"
  CHECK (length("name") BETWEEN 1 AND 80);
ALTER TABLE "pos_tables" ADD CONSTRAINT "pos_tables_values_ck"
  CHECK ("seats" BETWEEN 1 AND 50 AND "grid_x" BETWEEN 0 AND 39 AND "grid_y" BETWEEN 0 AND 39
     AND length("code") BETWEEN 1 AND 20);
ALTER TABLE "pos_tabs" ADD CONSTRAINT "pos_tabs_values_ck"
  CHECK ("guests" BETWEEN 1 AND 500
     AND (("status" = 'OPEN') = ("closed_at" IS NULL))
     AND (("status" = 'MERGED') = ("merged_into_tab_id" IS NOT NULL))
     AND ("status" <> 'CANCELLED' OR length("cancel_reason") BETWEEN 1 AND 500)
     AND ("table_id" IS NOT NULL OR length("label") BETWEEN 1 AND 60));
ALTER TABLE "pos_tab_lines" ADD CONSTRAINT "pos_tab_lines_values_ck"
  CHECK ("quantity" > 0 AND "paid_quantity" >= 0 AND "paid_quantity" <= "quantity"
     AND "course" BETWEEN 1 AND 9 AND ("seat" IS NULL OR "seat" BETWEEN 1 AND 500)
     AND ("status" = 'PENDING' OR "sent_at" IS NOT NULL)
     AND ("status" <> 'VOIDED' OR ("voided_at" IS NOT NULL AND length("void_reason") BETWEEN 1 AND 500
                                    AND "paid_quantity" = 0)));

-- One open check per table.
CREATE UNIQUE INDEX "pos_tabs_one_open_per_table" ON "pos_tabs" ("table_id") WHERE "status" = 'OPEN';

-- Only items not yet sent to the kitchen can be deleted; a sent item is voided with a reason.
CREATE FUNCTION "pos_tab_line_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' OR OLD."paid_quantity" > 0 THEN
    RAISE EXCEPTION 'only unsent, unpaid check items can be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "pos_tab_lines_delete_guard" BEFORE DELETE ON "pos_tab_lines"
  FOR EACH ROW EXECUTE FUNCTION "pos_tab_line_delete_guard"();

-- A sent item's item, options and quantity cannot change (the kitchen made it).
CREATE FUNCTION "pos_tab_line_sent_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' AND (NEW."menu_item_id", NEW."option_ids", NEW."quantity", NEW."sent_at")
       IS DISTINCT FROM (OLD."menu_item_id", OLD."option_ids", OLD."quantity", OLD."sent_at") THEN
    RAISE EXCEPTION 'a sent check item cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'VOIDED' AND NEW."status" <> 'VOIDED' THEN
    RAISE EXCEPTION 'a voided check item stays voided' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pos_tab_lines_sent_guard" BEFORE UPDATE ON "pos_tab_lines"
  FOR EACH ROW EXECUTE FUNCTION "pos_tab_line_sent_guard"();

GRANT SELECT, INSERT, UPDATE ON "pos_floors", "pos_tables", "pos_tabs" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "pos_tab_lines" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_floors', 'pos_tables', 'pos_tabs', 'pos_tab_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- The Waiter system role for existing organizations; mirrors SYSTEM_ROLE_TEMPLATES.
INSERT INTO "roles" ("id", "organization_id", "key", "name", "description", "is_system", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", 'waiter', 'Waiter',
       'Opens checks at tables, adds items and sends them to the kitchen (usually granted at branch scope).', true, now(), now()
FROM "organizations" o
ON CONFLICT ("organization_id", "key") DO NOTHING;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'pos.tables'), ('operations_manager', 'pos.tables'), ('branch_manager', 'pos.tables'),
  ('waiter', 'pos.tables'), ('waiter', 'menu.view')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
