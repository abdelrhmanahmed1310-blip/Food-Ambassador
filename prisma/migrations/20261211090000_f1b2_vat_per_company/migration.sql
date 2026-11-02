
-- DropIndex
DROP INDEX "tax_rates_organization_id_tax_code_id_effective_from_key";

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "vat_registered" BOOLEAN NOT NULL DEFAULT false;







-- AlterTable
ALTER TABLE "tax_rates" ADD COLUMN     "country" CHAR(2);

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_organization_id_tax_code_id_country_effective_fro_key" ON "tax_rates"("organization_id", "tax_code_id", "country", "effective_from");


-- Hand-written (ADR-084) --------------------------------------------------------
-- Existing rates are the organization's VAT country's; default companies
-- take the organization's current VAT registration.
-- tax_rates is append-only; the one-off tagging runs with its triggers off.
ALTER TABLE "tax_rates" DISABLE TRIGGER USER;
UPDATE "tax_rates" r SET "country" = t."country"
FROM "tax_settings" t WHERE t."organization_id" = r."organization_id" AND t."country" IS NOT NULL;
ALTER TABLE "tax_rates" ENABLE TRIGGER USER;

UPDATE "companies" c SET "vat_registered" = t."vat_registered",
  "country" = COALESCE(c."country", t."country"), "vat_number" = COALESCE(c."vat_number", t."vat_number")
FROM "tax_settings" t WHERE t."organization_id" = c."organization_id" AND c."is_default";

ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_country_ck" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');
ALTER TABLE "companies" ADD CONSTRAINT "companies_vat_ck"
  CHECK (NOT "vat_registered" OR ("vat_number" IS NOT NULL AND "country" IS NOT NULL));
