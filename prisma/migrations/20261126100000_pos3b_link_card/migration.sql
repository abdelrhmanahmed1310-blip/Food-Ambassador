-- DropIndex

-- AlterTable
ALTER TABLE "payment_links" ADD COLUMN     "card_last4" TEXT,
ADD COLUMN     "card_scheme" "CardScheme";

ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_card_ck" CHECK ("card_last4" IS NULL OR "card_last4" ~ '^[0-9]{4}$');
