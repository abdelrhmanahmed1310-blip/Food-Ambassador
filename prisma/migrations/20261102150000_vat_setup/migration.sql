-- CreateEnum
CREATE TYPE "TaxCategory" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "purchase_tax_code_id" UUID;

-- AlterTable
ALTER TABLE "recipe_prices" ADD COLUMN     "includes_tax" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN     "tax_code_id" UUID;

-- AlterTable
ALTER TABLE "sales_imports" ADD COLUMN     "gross_amount" DECIMAL(19,4),
ADD COLUMN     "tax_amount" DECIMAL(19,4);

-- AlterTable
ALTER TABLE "sales_lines" ADD COLUMN     "gross_amount" DECIMAL(19,4),
ADD COLUMN     "tax_amount" DECIMAL(19,4),
ADD COLUMN     "tax_code_id" UUID,
ADD COLUMN     "tax_rate" DECIMAL(7,6);

-- CreateTable
CREATE TABLE "tax_codes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "category" "TaxCategory" NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tax_code_id" UUID NOT NULL,
    "rate" DECIMAL(7,6) NOT NULL,
    "effective_from" DATE NOT NULL,
    "source" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_settings" (
    "organization_id" UUID NOT NULL,
    "country" CHAR(2),
    "vat_registered" BOOLEAN NOT NULL DEFAULT false,
    "vat_number" TEXT,
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT false,
    "default_sales_tax_code_id" UUID,
    "default_purchase_tax_code_id" UUID,
    "preset_applied_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_codes_organization_id_id_key" ON "tax_codes"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_codes_organization_id_code_key" ON "tax_codes"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_organization_id_id_key" ON "tax_rates"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_organization_id_tax_code_id_effective_from_key" ON "tax_rates"("organization_id", "tax_code_id", "effective_from");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_purchase_tax_code_id_fkey" FOREIGN KEY ("organization_id", "purchase_tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_organization_id_default_sales_tax_code_id_fkey" FOREIGN KEY ("organization_id", "default_sales_tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_organization_id_default_purchase_tax_code_id_fkey" FOREIGN KEY ("organization_id", "default_purchase_tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-037) ───

ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_rate_ck" CHECK ("rate" >= 0 AND "rate" < 1);
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_country_ck"
  CHECK ("country" IS NULL OR "country" IN ('SA', 'AE', 'BH', 'OM', 'QA', 'KW', 'EG'));
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_tax_ck"
  CHECK (("tax_code_id" IS NULL) = ("tax_rate" IS NULL)
         AND ("tax_amount" IS NULL OR "gross_amount" IS NOT NULL));

-- Rates are history: append-only.
CREATE TRIGGER "tax_rates_append_only" BEFORE UPDATE OR DELETE ON "tax_rates"
  FOR EACH ROW EXECUTE FUNCTION "reject_modification"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "tax_codes", "tax_settings" TO fa_tenant;
GRANT SELECT, INSERT ON "tax_rates" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_codes', 'tax_rates', 'tax_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
