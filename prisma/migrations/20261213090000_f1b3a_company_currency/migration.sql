-- Currency per company, step 3a (ADR-086). No table changes: companies.currency
-- exists since F1a. These rules keep amounts in one currency per company.

-- The currency of a warehouse is its branch's company's.
CREATE FUNCTION "warehouse_currency"(wid uuid) RETURNS char(3) LANGUAGE sql STABLE AS $$
  SELECT c."currency" FROM "warehouses" w JOIN "branches" b ON b."id" = w."branch_id"
  JOIN "companies" c ON c."id" = b."company_id" WHERE w."id" = wid
$$;

-- Stock never moves between companies with different currencies (no
-- inter-company transfer yet; transfers are within one country for now).
CREATE FUNCTION "stock_move_same_currency"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src uuid; dst uuid;
BEGIN
  IF TG_TABLE_NAME = 'inventory_documents' THEN
    src := NEW."warehouse_id"; dst := NEW."destination_warehouse_id";
  ELSE
    src := NEW."from_warehouse_id"; dst := NEW."to_warehouse_id";
  END IF;
  IF dst IS NOT NULL AND "warehouse_currency"(src) IS DISTINCT FROM "warehouse_currency"(dst) THEN
    RAISE EXCEPTION 'stock cannot move between companies with different currencies' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "inventory_documents_same_currency" BEFORE INSERT ON "inventory_documents"
  FOR EACH ROW EXECUTE FUNCTION "stock_move_same_currency"();
CREATE TRIGGER "stock_shipments_same_currency" BEFORE INSERT OR UPDATE OF "from_warehouse_id", "to_warehouse_id" ON "stock_shipments"
  FOR EACH ROW EXECUTE FUNCTION "stock_move_same_currency"();

-- Money documents are kept in their company's currency flow by flow; until a
-- flow is converted (ADR-086 steps 3b/3c), it refuses companies whose
-- currency is not the group's. Each later step drops its tables' triggers.
CREATE FUNCTION "company_currency_supported"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur char(3); base char(3);
BEGIN
  SELECT "base_currency" INTO base FROM "organizations" WHERE "id" = NEW."organization_id";
  IF TG_TABLE_NAME = 'sales_imports' THEN
    cur := "warehouse_currency"(NEW."warehouse_id");
  ELSE
    SELECT "currency" INTO cur FROM "companies" WHERE "id" = NEW."company_id";
  END IF;
  IF cur IS DISTINCT FROM base THEN
    RAISE EXCEPTION '% is not yet available for a company keeping its books in %', TG_TABLE_NAME, cur
      USING ERRCODE = 'feature_not_supported';
  END IF;
  RETURN NEW;
END $$;
-- Named after the company triggers so they run once company_id is set.
CREATE TRIGGER "pos_orders_currency_guard" BEFORE INSERT ON "pos_orders" FOR EACH ROW EXECUTE FUNCTION "company_currency_supported"();
CREATE TRIGGER "purchase_orders_currency_guard" BEFORE INSERT ON "purchase_orders" FOR EACH ROW EXECUTE FUNCTION "company_currency_supported"();
CREATE TRIGGER "goods_receipts_currency_guard" BEFORE INSERT ON "goods_receipts" FOR EACH ROW EXECUTE FUNCTION "company_currency_supported"();
CREATE TRIGGER "sales_orders_currency_guard" BEFORE INSERT ON "sales_orders" FOR EACH ROW EXECUTE FUNCTION "company_currency_supported"();
CREATE TRIGGER "sales_invoices_currency_guard" BEFORE INSERT ON "sales_invoices" FOR EACH ROW EXECUTE FUNCTION "company_currency_supported"();
CREATE TRIGGER "supplier_invoices_currency_guard" BEFORE INSERT ON "supplier_invoices" FOR EACH ROW EXECUTE FUNCTION "company_currency_supported"();
CREATE TRIGGER "sales_imports_currency_guard" BEFORE INSERT ON "sales_imports" FOR EACH ROW EXECUTE FUNCTION "company_currency_supported"();

-- A company's currency is fixed once it has stock or money documents.
CREATE FUNCTION "company_currency_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currency" IS DISTINCT FROM OLD."currency" AND (
       EXISTS (SELECT 1 FROM "pos_orders" WHERE "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "purchase_orders" WHERE "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "goods_receipts" WHERE "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "sales_orders" WHERE "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "supplier_invoices" WHERE "company_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "inventory_ledger_entries" e JOIN "warehouses" w ON w."id" = e."warehouse_id"
               JOIN "branches" b ON b."id" = w."branch_id" WHERE b."company_id" = OLD."id")) THEN
    RAISE EXCEPTION 'the company''s currency is fixed once it has stock or documents' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "companies_currency_fixed" BEFORE UPDATE OF "currency" ON "companies"
  FOR EACH ROW EXECUTE FUNCTION "company_currency_fixed"();
