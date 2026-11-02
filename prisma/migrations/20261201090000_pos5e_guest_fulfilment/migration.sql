-- CreateEnum
CREATE TYPE "GuestPaymentMode" AS ENUM ('COUNTER', 'ONLINE', 'CHOICE');


-- AlterTable
ALTER TABLE "ordering_channels" ADD COLUMN     "days_ahead" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lead_minutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "open_from" TEXT,
ADD COLUMN     "open_to" TEXT,
ADD COLUMN     "payment_mode" "GuestPaymentMode" NOT NULL DEFAULT 'COUNTER',
ADD COLUMN     "register_id" UUID,
ADD COLUMN     "scheduling" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slot_minutes" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "pos_tabs" ADD COLUMN     "accepted_at" TIMESTAMPTZ(3),
ADD COLUMN     "pay_online" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "picked_up_at" TIMESTAMPTZ(3),
ADD COLUMN     "pickup_at" TIMESTAMPTZ(3),
ADD COLUMN     "ready_at" TIMESTAMPTZ(3);

-- AddForeignKey
ALTER TABLE "ordering_channels" ADD CONSTRAINT "ordering_channels_organization_id_register_id_fkey" FOREIGN KEY ("organization_id", "register_id") REFERENCES "pos_registers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules (ADR-071) ───
ALTER TABLE "ordering_channels" ADD CONSTRAINT "ordering_channels_fulfilment_ck"
  CHECK (("payment_mode" = 'COUNTER' OR "register_id" IS NOT NULL)
     AND ("open_from" IS NULL OR "open_from" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     AND ("open_to" IS NULL OR "open_to" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
     AND (NOT "scheduling" OR ("open_from" IS NOT NULL AND "open_to" IS NOT NULL))
     AND "slot_minutes" IN (5, 10, 15, 20, 30, 60)
     AND "lead_minutes" BETWEEN 0 AND 240 AND "days_ahead" BETWEEN 0 AND 7);
-- Fulfilment happens in order: accepted, then ready, then handed over.
ALTER TABLE "pos_tabs" ADD CONSTRAINT "pos_tabs_fulfilment_ck"
  CHECK (("source" <> 'STAFF' OR ("pay_online" = false AND "pickup_at" IS NULL AND "accepted_at" IS NULL
                                   AND "ready_at" IS NULL AND "picked_up_at" IS NULL))
     AND ("ready_at" IS NULL OR "accepted_at" IS NOT NULL)
     AND ("picked_up_at" IS NULL OR "accepted_at" IS NOT NULL));
