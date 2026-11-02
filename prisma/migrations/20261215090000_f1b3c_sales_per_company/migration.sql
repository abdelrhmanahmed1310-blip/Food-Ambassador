-- Currency per company, step 3c (ADR-086): the point of sale, sales imports and
-- B2B now keep amounts in the company's currency; the temporary guards go.
DROP TRIGGER "pos_orders_currency_guard" ON "pos_orders";
DROP TRIGGER "sales_orders_currency_guard" ON "sales_orders";
DROP TRIGGER "sales_invoices_currency_guard" ON "sales_invoices";
DROP TRIGGER "sales_imports_currency_guard" ON "sales_imports";
DROP FUNCTION "company_currency_supported"();

-- A gift card is spent only where its currency is (also checked by the service).
CREATE FUNCTION "gift_card_payment_currency"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."gift_card_id" IS NOT NULL AND (SELECT "currency" FROM "gift_cards" WHERE "id" = NEW."gift_card_id")
     IS DISTINCT FROM (SELECT c."currency" FROM "pos_orders" o JOIN "companies" c ON c."id" = o."company_id" WHERE o."id" = NEW."order_id") THEN
    RAISE EXCEPTION 'the gift card is in another currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pos_payments_gift_card_currency" BEFORE INSERT ON "pos_payments"
  FOR EACH ROW EXECUTE FUNCTION "gift_card_payment_currency"();
