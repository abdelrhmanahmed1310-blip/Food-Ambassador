
-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "brand_id" UUID,
ADD COLUMN     "company_id" UUID;

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "country" CHAR(2),
    "currency" CHAR(3) NOT NULL,
    "vat_number" TEXT,
    "cr_number" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_organization_id_id_key" ON "companies"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "companies_organization_id_code_key" ON "companies"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "brands_organization_id_id_key" ON "brands"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_organization_id_code_key" ON "brands"("organization_id", "code");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (ADR-082) --------------------------------------------------------

-- One default company per existing organization, from its current settings
-- (VAT number and country from tax settings; legal name and CR from ZATCA).
INSERT INTO "companies" ("id", "organization_id", "code", "name", "legal_name", "country", "currency",
                         "vat_number", "cr_number", "is_default", "updated_at")
SELECT gen_random_uuid(), o."id", 'MAIN', o."name", COALESCE(z."legal_name", o."name"),
       t."country", o."base_currency", t."vat_number", z."cr_number", true, now()
FROM "organizations" o
LEFT JOIN "tax_settings" t ON t."organization_id" = o."id"
LEFT JOIN "zatca_settings" z ON z."organization_id" = o."id";

UPDATE "branches" b SET "company_id" = c."id"
FROM "companies" c WHERE c."organization_id" = b."organization_id" AND c."is_default";

ALTER TABLE "branches" ALTER COLUMN "company_id" SET NOT NULL;

ALTER TABLE "companies" ADD CONSTRAINT "companies_values_ck"
  CHECK (length("code") BETWEEN 1 AND 20 AND length("name") BETWEEN 1 AND 120
    AND length("legal_name") BETWEEN 1 AND 200
    AND ("country" IS NULL OR "country" ~ '^[A-Z]{2}$') AND "currency" ~ '^[A-Z]{3}$'
    AND NOT ("is_default" AND "archived_at" IS NOT NULL));
CREATE UNIQUE INDEX "companies_one_default" ON "companies" ("organization_id") WHERE "is_default";

ALTER TABLE "brands" ADD CONSTRAINT "brands_values_ck"
  CHECK (length("code") BETWEEN 1 AND 20 AND length("name") BETWEEN 1 AND 120);

GRANT SELECT, INSERT, UPDATE ON "companies" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "brands" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies', 'brands']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
