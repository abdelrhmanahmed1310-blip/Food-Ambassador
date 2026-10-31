-- A draft has no confirmation; any other status except a cancelled draft has one (ADR-047).
ALTER TABLE "sales_orders" DROP CONSTRAINT "sales_orders_status_ck";
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_status_ck"
  CHECK (("status" <> 'DRAFT' OR "confirmed_at" IS NULL)
     AND ("status" IN ('DRAFT', 'CANCELLED') OR "confirmed_at" IS NOT NULL)
     AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)));
