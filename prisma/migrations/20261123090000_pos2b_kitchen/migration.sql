-- CreateEnum
CREATE TYPE "KitchenTicketStatus" AS ENUM ('OPEN', 'DONE');

-- DropIndex

-- CreateTable
CREATE TABLE "kitchen_stations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_minutes" INTEGER NOT NULL DEFAULT 12,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kitchen_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_routes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "station_id" UUID NOT NULL,
    "category_id" UUID,
    "menu_item_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kitchen_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_tickets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "station_id" UUID NOT NULL,
    "tab_id" UUID,
    "order_id" UUID,
    "label" TEXT NOT NULL,
    "guests" INTEGER,
    "status" "KitchenTicketStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bumped_at" TIMESTAMPTZ(3),
    "bumped_by_user_id" UUID,

    CONSTRAINT "kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_ticket_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "tab_line_id" UUID,
    "order_line_id" UUID,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "options" JSONB NOT NULL,
    "note" TEXT,
    "seat" INTEGER,
    "course" INTEGER,
    "voided_at" TIMESTAMPTZ(3),

    CONSTRAINT "kitchen_ticket_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_stations_organization_id_id_key" ON "kitchen_stations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_stations_organization_id_branch_id_code_key" ON "kitchen_stations"("organization_id", "branch_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_routes_organization_id_branch_id_category_id_key" ON "kitchen_routes"("organization_id", "branch_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_routes_organization_id_branch_id_menu_item_id_key" ON "kitchen_routes"("organization_id", "branch_id", "menu_item_id");

-- CreateIndex
CREATE INDEX "kitchen_tickets_organization_id_station_id_status_idx" ON "kitchen_tickets"("organization_id", "station_id", "status");

-- CreateIndex
CREATE INDEX "kitchen_tickets_organization_id_tab_id_idx" ON "kitchen_tickets"("organization_id", "tab_id");

-- CreateIndex
CREATE INDEX "kitchen_tickets_organization_id_order_id_idx" ON "kitchen_tickets"("organization_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_tickets_organization_id_id_key" ON "kitchen_tickets"("organization_id", "id");

-- CreateIndex
CREATE INDEX "kitchen_ticket_items_organization_id_tab_line_id_idx" ON "kitchen_ticket_items"("organization_id", "tab_line_id");

-- CreateIndex
CREATE INDEX "kitchen_ticket_items_organization_id_order_line_id_idx" ON "kitchen_ticket_items"("organization_id", "order_line_id");

-- AddForeignKey
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_organization_id_station_id_fkey" FOREIGN KEY ("organization_id", "station_id") REFERENCES "kitchen_stations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "menu_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_organization_id_menu_item_id_fkey" FOREIGN KEY ("organization_id", "menu_item_id") REFERENCES "menu_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_organization_id_station_id_fkey" FOREIGN KEY ("organization_id", "station_id") REFERENCES "kitchen_stations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_organization_id_ticket_id_fkey" FOREIGN KEY ("organization_id", "ticket_id") REFERENCES "kitchen_tickets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules, access and row-level security (ADR-063) ───

ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_values_ck"
  CHECK ("target_minutes" BETWEEN 1 AND 240 AND length("code") BETWEEN 1 AND 20
     AND length("name") BETWEEN 1 AND 80);
-- At most one default station per branch.
CREATE UNIQUE INDEX "kitchen_stations_one_default" ON "kitchen_stations" ("organization_id", "branch_id")
  WHERE "is_default" AND "archived_at" IS NULL;
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_target_ck"
  CHECK (num_nonnulls("category_id", "menu_item_id") = 1);
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_values_ck"
  CHECK (num_nonnulls("tab_id", "order_id") = 1
     AND (("status" = 'DONE') = ("bumped_at" IS NOT NULL))
     AND length("label") BETWEEN 1 AND 80);
ALTER TABLE "kitchen_ticket_items" ADD CONSTRAINT "kitchen_ticket_items_values_ck"
  CHECK ("quantity" > 0 AND num_nonnulls("tab_line_id", "order_line_id") = 1);

GRANT SELECT, INSERT, UPDATE ON "kitchen_stations", "kitchen_tickets", "kitchen_ticket_items" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "kitchen_routes" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kitchen_stations', 'kitchen_routes', 'kitchen_tickets', 'kitchen_ticket_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- The Kitchen system role for existing organizations; mirrors SYSTEM_ROLE_TEMPLATES.
INSERT INTO "roles" ("id", "organization_id", "key", "name", "description", "is_system", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", 'kitchen', 'Kitchen',
       'Works the kitchen screens: sees tickets and bumps them when ready (usually granted at branch scope).', true, now(), now()
FROM "organizations" o
ON CONFLICT ("organization_id", "key") DO NOTHING;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'pos.kitchen'), ('operations_manager', 'pos.kitchen'), ('branch_manager', 'pos.kitchen'),
  ('kitchen', 'pos.kitchen')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
