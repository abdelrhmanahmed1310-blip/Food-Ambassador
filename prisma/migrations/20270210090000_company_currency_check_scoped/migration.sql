-- The company-currency guard (ADR-086) looked for documents and stock across every
-- organization: whole-table scans on each currency change. Each check now filters by
-- the company's organization first, so it uses the organization-leading indexes.
CREATE OR REPLACE FUNCTION "company_currency_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currency" IS DISTINCT FROM OLD."currency" AND (
       EXISTS (SELECT 1 FROM "pos_orders"
               WHERE "organization_id" = OLD."organization_id" AND "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "purchase_orders"
               WHERE "organization_id" = OLD."organization_id" AND "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "goods_receipts"
               WHERE "organization_id" = OLD."organization_id" AND "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "sales_orders"
               WHERE "organization_id" = OLD."organization_id" AND "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "supplier_invoices"
               WHERE "organization_id" = OLD."organization_id" AND "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "inventory_ledger_entries" e
               JOIN "warehouses" w ON w."id" = e."warehouse_id"
               JOIN "branches" b ON b."id" = w."branch_id"
               WHERE e."organization_id" = OLD."organization_id"
                 AND w."organization_id" = OLD."organization_id"
                 AND b."company_id" = OLD."id")) THEN
    RAISE EXCEPTION 'the company''s currency is fixed once it has stock or documents' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
