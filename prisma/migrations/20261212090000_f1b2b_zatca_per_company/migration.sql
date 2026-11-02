-- ZATCA e-invoicing per company (ADR-085).

-- AlterTable
ALTER TABLE "zatca_devices" ADD COLUMN     "company_id" UUID;

-- AlterTable: seller settings become per company; existing ones belong to the default company.
ALTER TABLE "zatca_settings" ADD COLUMN "company_id" UUID;
UPDATE "zatca_settings" z SET "company_id" = c."id"
  FROM "companies" c WHERE c."organization_id" = z."organization_id" AND c."is_default";
ALTER TABLE "zatca_settings" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "zatca_settings" DROP CONSTRAINT "zatca_settings_pkey",
ADD CONSTRAINT "zatca_settings_pkey" PRIMARY KEY ("organization_id", "company_id");

-- AddForeignKey
ALTER TABLE "zatca_settings" ADD CONSTRAINT "zatca_settings_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zatca_devices" ADD CONSTRAINT "zatca_devices_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (ADR-085) --------------------------------------------------------
-- A unit signs for one company: a register's unit for its branch's company,
-- the office unit for the company it was made for (one office unit per company).
UPDATE "zatca_devices" d SET "company_id" = b."company_id"
  FROM "pos_registers" r JOIN "branches" b ON b."id" = r."branch_id" WHERE r."id" = d."register_id";
UPDATE "zatca_devices" d SET "company_id" = c."id"
  FROM "companies" c WHERE d."register_id" IS NULL AND c."organization_id" = d."organization_id" AND c."is_default";
ALTER TABLE "zatca_devices" ALTER COLUMN "company_id" SET NOT NULL;

CREATE FUNCTION "zatca_device_company"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."register_id" IS NOT NULL THEN
    NEW."company_id" := (SELECT b."company_id" FROM "pos_registers" r JOIN "branches" b ON b."id" = r."branch_id"
                         WHERE r."id" = NEW."register_id");
  ELSIF NEW."company_id" IS NULL THEN
    NEW."company_id" := (SELECT "id" FROM "companies" WHERE "organization_id" = NEW."organization_id" AND "is_default");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "zatca_devices_company" BEFORE INSERT ON "zatca_devices"
  FOR EACH ROW EXECUTE FUNCTION "zatca_device_company"();
CREATE TRIGGER "zatca_devices_company_fixed" BEFORE UPDATE ON "zatca_devices"
  FOR EACH ROW EXECUTE FUNCTION "company_fixed"();

DROP INDEX "zatca_devices_one_office";
CREATE UNIQUE INDEX "zatca_devices_one_office" ON "zatca_devices" ("organization_id", "company_id") WHERE "purpose" = 'OFFICE';
