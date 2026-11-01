-- CreateEnum
CREATE TYPE "LoyaltyEntryKind" AS ENUM ('EARN', 'REDEEM', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "GiftCardEntryKind" AS ENUM ('ISSUE', 'REDEEM', 'REVERSAL');

-- AlterEnum
ALTER TYPE "PosPaymentMethod" ADD VALUE 'GIFT_CARD';


-- AlterTable
ALTER TABLE "pos_orders" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "loyalty_points" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "pos_payments" ADD COLUMN     "gift_card_id" UUID;

-- CreateTable
CREATE TABLE "pos_customers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "consent_at" TIMESTAMPTZ(3),
    "points_balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ(3),

    CONSTRAINT "pos_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_settings" (
    "organization_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "earn_rate" DECIMAL(9,4) NOT NULL,
    "point_value" DECIMAL(9,4) NOT NULL,
    "min_redeem_points" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "loyalty_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "kind" "LoyaltyEntryKind" NOT NULL,
    "points" INTEGER NOT NULL,
    "order_id" UUID,
    "reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_cards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "initial_value" DECIMAL(19,4) NOT NULL,
    "balance" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "shift_id" UUID NOT NULL,
    "sold_method" "PosPaymentMethod" NOT NULL,
    "sold_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked_at" TIMESTAMPTZ(3),

    CONSTRAINT "gift_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gift_card_id" UUID NOT NULL,
    "kind" "GiftCardEntryKind" NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "order_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_card_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_customers_organization_id_id_key" ON "pos_customers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_customers_organization_id_phone_key" ON "pos_customers"("organization_id", "phone");

-- CreateIndex
CREATE INDEX "loyalty_entries_organization_id_customer_id_idx" ON "loyalty_entries"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "gift_cards_organization_id_shift_id_idx" ON "gift_cards"("organization_id", "shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_cards_organization_id_id_key" ON "gift_cards"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_cards_organization_id_code_hash_key" ON "gift_cards"("organization_id", "code_hash");

-- CreateIndex
CREATE INDEX "gift_card_entries_organization_id_gift_card_id_idx" ON "gift_card_entries"("organization_id", "gift_card_id");

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "pos_customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_organization_id_gift_card_id_fkey" FOREIGN KEY ("organization_id", "gift_card_id") REFERENCES "gift_cards"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_customers" ADD CONSTRAINT "pos_customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "pos_customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "pos_shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_organization_id_gift_card_id_fkey" FOREIGN KEY ("organization_id", "gift_card_id") REFERENCES "gift_cards"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules, access and row-level security (ADR-068) ───
-- The new enum value is compared as text: it cannot be used as an enum literal
-- in the transaction that adds it.
ALTER TABLE "pos_customers" ADD CONSTRAINT "pos_customers_values_ck"
  CHECK (length("name") BETWEEN 1 AND 120 AND "points_balance" >= 0
     AND ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$')
     AND ("erased_at" IS NOT NULL OR "phone" IS NOT NULL)
     AND ("erased_at" IS NULL OR ("phone" IS NULL AND "email" IS NULL AND NOT "marketing_consent"))
     AND ("marketing_consent" = ("consent_at" IS NOT NULL))
     AND ("email" IS NULL OR length("email") <= 254));
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_values_ck"
  CHECK ("earn_rate" >= 0 AND "point_value" > 0 AND "min_redeem_points" >= 0);
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_values_ck"
  CHECK ("points" <> 0
     AND ("kind" <> 'EARN' OR "points" > 0)
     AND ("kind" <> 'REDEEM' OR "points" < 0)
     AND ("kind" NOT IN ('EARN', 'REDEEM') OR "order_id" IS NOT NULL)
     AND ("kind" <> 'ADJUSTMENT' OR "reason" IS NOT NULL));
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_values_ck"
  CHECK ("initial_value" > 0 AND "balance" >= 0 AND "balance" <= "initial_value"
     AND "last4" ~ '^[0-9]{4}$' AND "sold_method"::text IN ('CASH', 'CARD'));
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_values_ck"
  CHECK ("amount" <> 0
     AND ("kind" <> 'REDEEM' OR ("amount" < 0 AND "order_id" IS NOT NULL))
     AND ("kind" = 'REDEEM' OR "amount" > 0));
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_gift_card_ck"
  CHECK (("method"::text = 'GIFT_CARD') = ("gift_card_id" IS NOT NULL));
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_method_ck"
  CHECK ("method"::text IN ('CASH', 'CARD'));
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_loyalty_ck"
  CHECK ("loyalty_points" >= 0 AND ("loyalty_points" = 0 OR "customer_id" IS NOT NULL));
-- An order discount comes from a reason (manual), a coupon or points.
ALTER TABLE "pos_orders" DROP CONSTRAINT "pos_orders_discount_ck";
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_discount_ck"
  CHECK ("promo_discount" >= 0 AND "order_discount" >= 0
     AND ("order_discount" = 0 OR "discount_reason" IS NOT NULL OR "coupon_id" IS NOT NULL
          OR "loyalty_points" > 0));

-- A gift card's value and sale are fixed; only its balance and block change.
CREATE TRIGGER "gift_cards_fixed" BEFORE UPDATE ON "gift_cards"
  FOR EACH ROW EXECUTE FUNCTION "pos_fixed_except"('balance', 'blocked_at');

GRANT SELECT, INSERT, UPDATE ON "pos_customers", "loyalty_settings", "gift_cards" TO fa_tenant;
GRANT SELECT, INSERT ON "loyalty_entries", "gift_card_entries" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_customers', 'loyalty_settings', 'loyalty_entries', 'gift_cards', 'gift_card_entries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'customers.view'), ('admin', 'customers.manage'),
             ('operations_manager', 'customers.view'), ('operations_manager', 'customers.manage'),
             ('branch_manager', 'customers.view'), ('branch_manager', 'customers.manage'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
