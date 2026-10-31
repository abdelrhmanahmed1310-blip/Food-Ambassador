-- AlterTable
ALTER TABLE "accounting_settings" ADD COLUMN     "output_vat_account" TEXT,
ADD COLUMN     "receipts_account" TEXT,
ADD COLUMN     "receivables_account" TEXT,
ADD COLUMN     "sales_account" TEXT;

-- AlterTable
ALTER TABLE "fx_revaluation_lines" ADD COLUMN     "customer_id" UUID,
ALTER COLUMN "supplier_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "fx_revaluations" ADD COLUMN     "receivables_difference_base" DECIMAL(19,4) NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "fx_revaluation_lines" ADD CONSTRAINT "fx_revaluation_lines_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A revaluation line is for exactly one supplier or one customer (ADR-056).
ALTER TABLE "fx_revaluation_lines" ADD CONSTRAINT "fx_revaluation_lines_party_ck"
  CHECK (("supplier_id" IS NULL) <> ("customer_id" IS NULL));
