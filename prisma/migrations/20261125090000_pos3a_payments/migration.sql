-- CreateEnum
CREATE TYPE "CardScheme" AS ENUM ('MADA', 'VISA', 'MASTERCARD', 'AMEX', 'OTHER');

-- CreateEnum
CREATE TYPE "SettlementMatch" AS ENUM ('MATCHED', 'AMOUNT_MISMATCH', 'UNMATCHED');

-- DropIndex

-- AlterTable
ALTER TABLE "pos_payments" ADD COLUMN     "approval_code" TEXT,
ADD COLUMN     "card_last4" TEXT,
ADD COLUMN     "card_scheme" "CardScheme",
ADD COLUMN     "terminal_id" TEXT,
ADD COLUMN     "tip" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "pos_refunds" ADD COLUMN     "reference" TEXT;

-- CreateTable
CREATE TABLE "card_settlement_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "imported_by_user_id" UUID NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_settlement_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_settlement_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "transaction_date" DATE NOT NULL,
    "terminal_id" TEXT,
    "approval_code" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "fee" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "payment_id" UUID,
    "match" "SettlementMatch" NOT NULL,

    CONSTRAINT "card_settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "card_settlement_batches_organization_id_id_key" ON "card_settlement_batches"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "card_settlement_batches_organization_id_sha256_key" ON "card_settlement_batches"("organization_id", "sha256");

-- CreateIndex
CREATE INDEX "card_settlement_lines_organization_id_transaction_date_idx" ON "card_settlement_lines"("organization_id", "transaction_date");

-- AddForeignKey
ALTER TABLE "card_settlement_batches" ADD CONSTRAINT "card_settlement_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_settlement_lines" ADD CONSTRAINT "card_settlement_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_settlement_lines" ADD CONSTRAINT "card_settlement_lines_organization_id_batch_id_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "card_settlement_batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_settlement_lines" ADD CONSTRAINT "card_settlement_lines_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "pos_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules, access and row-level security (ADR-065) ───

-- Card details only on card payments; only the last 4 digits are ever kept.
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_card_ck"
  CHECK ("tip" >= 0
     AND ("method" = 'CARD' OR ("card_scheme" IS NULL AND "terminal_id" IS NULL
                                AND "approval_code" IS NULL AND "card_last4" IS NULL AND "tip" = 0))
     AND ("card_last4" IS NULL OR "card_last4" ~ '^[0-9]{4}$')
     AND ("approval_code" IS NULL OR "approval_code" ~ '^[A-Za-z0-9]{1,12}$'));
ALTER TABLE "card_settlement_lines" ADD CONSTRAINT "card_settlement_lines_values_ck"
  CHECK ("amount" > 0 AND "fee" >= 0 AND (("match" = 'UNMATCHED') = ("payment_id" IS NULL)));
-- A card payment is paid out once.
CREATE UNIQUE INDEX "card_settlement_lines_one_per_payment" ON "card_settlement_lines" ("payment_id")
  WHERE "payment_id" IS NOT NULL;

GRANT SELECT, INSERT ON "card_settlement_batches", "card_settlement_lines" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['card_settlement_batches', 'card_settlement_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
