-- CreateEnum
CREATE TYPE "DiscountKind" AS ENUM ('PERCENT', 'AMOUNT');

-- DropIndex

-- AlterTable
ALTER TABLE "pos_order_lines" ADD COLUMN     "discount_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
ADD COLUMN     "promotion_id" UUID;

-- AlterTable
ALTER TABLE "pos_orders" ADD COLUMN     "coupon_id" UUID,
ADD COLUMN     "discount_reason" TEXT,
ADD COLUMN     "order_discount" DECIMAL(19,4) NOT NULL DEFAULT 0,
ADD COLUMN     "promo_discount" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "pos_promotions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "category_ids" UUID[],
    "item_ids" UUID[],
    "channels" "SalesChannel"[],
    "weekdays" INTEGER[],
    "start_time" TEXT,
    "end_time" TEXT,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "pos_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_coupons" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "DiscountKind" NOT NULL,
    "value" DECIMAL(19,4) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "max_uses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_promotions_organization_id_archived_at_idx" ON "pos_promotions"("organization_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_coupons_organization_id_code_key" ON "pos_coupons"("organization_id", "code");

-- AddForeignKey
ALTER TABLE "pos_promotions" ADD CONSTRAINT "pos_promotions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_coupons" ADD CONSTRAINT "pos_coupons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CreateIndex
CREATE UNIQUE INDEX "pos_coupons_organization_id_id_key" ON "pos_coupons"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_promotions_organization_id_id_key" ON "pos_promotions"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_organization_id_coupon_id_fkey" FOREIGN KEY ("organization_id", "coupon_id") REFERENCES "pos_coupons"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_organization_id_promotion_id_fkey" FOREIGN KEY ("organization_id", "promotion_id") REFERENCES "pos_promotions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written: rules, access and row-level security (ADR-067) ───
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_discount_ck"
  CHECK ("promo_discount" >= 0 AND "order_discount" >= 0
     AND ("order_discount" = 0 OR "discount_reason" IS NOT NULL OR "coupon_id" IS NOT NULL));
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_discount_ck" CHECK ("discount_amount" >= 0);
ALTER TABLE "pos_promotions" ADD CONSTRAINT "pos_promotions_values_ck"
  CHECK ("percent" > 0 AND "percent" <= 100 AND length("name") BETWEEN 1 AND 80
     AND cardinality("category_ids") + cardinality("item_ids") > 0
     AND "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
     AND (("start_time" IS NULL) = ("end_time" IS NULL))
     AND ("start_time" IS NULL OR ("start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
     AND ("valid_to" IS NULL OR "valid_to" >= "valid_from"));
ALTER TABLE "pos_coupons" ADD CONSTRAINT "pos_coupons_values_ck"
  CHECK ("value" > 0 AND ("kind" = 'AMOUNT' OR "value" <= 100) AND "uses" >= 0
     AND ("max_uses" IS NULL OR ("max_uses" > 0 AND "uses" <= "max_uses"))
     AND "code" ~ '^[A-Z0-9-]{3,30}$' AND ("valid_to" IS NULL OR "valid_to" >= "valid_from"));
-- A promotion is never edited (orders queued offline were priced with it); it is archived.
CREATE TRIGGER "pos_promotions_fixed" BEFORE UPDATE ON "pos_promotions"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('archived_at');
CREATE TRIGGER "pos_coupons_fixed" BEFORE UPDATE ON "pos_coupons"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('uses', 'archived_at');

GRANT SELECT, INSERT, UPDATE ON "pos_promotions", "pos_coupons" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_promotions', 'pos_coupons']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'pos.discount'), ('operations_manager', 'pos.discount'), ('branch_manager', 'pos.discount'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
