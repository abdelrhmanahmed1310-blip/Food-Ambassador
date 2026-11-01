-- CreateEnum
CREATE TYPE "DeliveryPlatform" AS ENUM ('HUNGERSTATION', 'JAHEZ', 'KEETA', 'OTHER');

-- CreateEnum
CREATE TYPE "DeliveryOrderStatus" AS ENUM ('PENDING', 'NEEDS_MAPPING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryMapKind" AS ENUM ('ITEM', 'OPTION');

-- AlterEnum
ALTER TYPE "ConnectorKind" ADD VALUE 'DELIVERY_ORDERS';

-- AlterEnum
ALTER TYPE "PosPaymentMethod" ADD VALUE 'DELIVERY_PLATFORM';


-- CreateTable
CREATE TABLE "delivery_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "platform" "DeliveryPlatform" NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_code" TEXT,
    "status" "DeliveryOrderStatus" NOT NULL,
    "payload" JSONB NOT NULL,
    "total" DECIMAL(19,4) NOT NULL,
    "customer_name" TEXT,
    "placed_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "problem" TEXT,
    "pos_order_id" UUID,

    CONSTRAINT "delivery_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_item_maps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "kind" "DeliveryMapKind" NOT NULL,
    "external_id" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_item_maps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_orders_organization_id_status_received_at_idx" ON "delivery_orders"("organization_id", "status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_orders_organization_id_id_key" ON "delivery_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_orders_connector_id_external_id_key" ON "delivery_orders"("connector_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_item_maps_connector_id_kind_external_id_key" ON "delivery_item_maps"("connector_id", "kind", "external_id");

-- AddForeignKey
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_organization_id_connector_id_fkey" FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_item_maps" ADD CONSTRAINT "delivery_item_maps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_item_maps" ADD CONSTRAINT "delivery_item_maps_organization_id_connector_id_fkey" FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX "delivery_orders_organization_id_pos_order_id_key" ON "delivery_orders"("organization_id", "pos_order_id");
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_organization_id_pos_order_id_fkey" FOREIGN KEY ("organization_id", "pos_order_id") REFERENCES "pos_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written: rules, access and row-level security (ADR-069) ───
-- New enum values are compared as text in this migration.
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_values_ck"
  CHECK ("total" >= 0 AND length("external_id") BETWEEN 1 AND 100
     AND ("display_code" IS NULL OR length("display_code") <= 40)
     AND ("customer_name" IS NULL OR length("customer_name") <= 80)
     AND ("status" <> 'ACCEPTED' OR "pos_order_id" IS NOT NULL)
     AND ("status" NOT IN ('ACCEPTED', 'REJECTED') OR "decided_at" IS NOT NULL));
ALTER TABLE "delivery_item_maps" ADD CONSTRAINT "delivery_item_maps_values_ck"
  CHECK (length("external_id") BETWEEN 1 AND 100);
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_platform_ck"
  CHECK ("method"::text <> 'DELIVERY_PLATFORM' OR "reference" IS NOT NULL);

-- What the platform sent is fixed; only the decision and its outcome change.
CREATE TRIGGER "delivery_orders_fixed" BEFORE UPDATE ON "delivery_orders"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('status', 'decided_at', 'decided_by_user_id', 'problem', 'pos_order_id');

GRANT SELECT, INSERT, UPDATE ON "delivery_orders" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "delivery_item_maps" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['delivery_orders', 'delivery_item_maps']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
