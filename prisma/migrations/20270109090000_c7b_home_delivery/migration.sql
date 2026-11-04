-- CreateEnum
CREATE TYPE "HomeDeliveryStatus" AS ENUM ('WAITING', 'ASSIGNED', 'OUT', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "home_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pos_order_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "status" "HomeDeliveryStatus" NOT NULL DEFAULT 'WAITING',
    "contact_name" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "directions" TEXT,
    "contact_purged_at" TIMESTAMPTZ(3),
    "rider_user_id" UUID,
    "assigned_at" TIMESTAMPTZ(3),
    "picked_up_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "recipient_name" TEXT,
    "failed_at" TIMESTAMPTZ(3),
    "failure_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "home_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "home_deliveries_organization_id_branch_id_status_idx" ON "home_deliveries"("organization_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "home_deliveries_organization_id_rider_user_id_status_idx" ON "home_deliveries"("organization_id", "rider_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "home_deliveries_organization_id_id_key" ON "home_deliveries"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "home_deliveries_organization_id_pos_order_id_key" ON "home_deliveries"("organization_id", "pos_order_id");

-- AddForeignKey
ALTER TABLE "home_deliveries" ADD CONSTRAINT "home_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_deliveries" ADD CONSTRAINT "home_deliveries_organization_id_pos_order_id_fkey" FOREIGN KEY ("organization_id", "pos_order_id") REFERENCES "pos_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_deliveries" ADD CONSTRAINT "home_deliveries_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_deliveries" ADD CONSTRAINT "home_deliveries_rider_user_id_fkey" FOREIGN KEY ("rider_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C7b own riders (ADR-117): hand-written rules ───
ALTER TABLE "home_deliveries" ADD CONSTRAINT "home_deliveries_ck" CHECK (
  ("address" IS NOT NULL OR "contact_purged_at" IS NOT NULL)
  AND ("status" NOT IN ('ASSIGNED', 'OUT', 'DELIVERED') OR "rider_user_id" IS NOT NULL)
  AND ("status" <> 'DELIVERED' OR "delivered_at" IS NOT NULL)
  AND ("status" <> 'FAILED' OR "failure_reason" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL)
  AND ("contact_purged_at" IS NULL OR "status" IN ('DELIVERED', 'FAILED', 'CANCELLED')));

GRANT SELECT, INSERT, UPDATE ON "home_deliveries" TO fa_tenant;
ALTER TABLE "home_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "home_deliveries" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'pos.dispatch'), ('operations_manager', 'pos.dispatch'),
             ('branch_manager', 'pos.dispatch'), ('cashier', 'pos.dispatch'),
             ('branch_manager', 'logistics.deliver'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
