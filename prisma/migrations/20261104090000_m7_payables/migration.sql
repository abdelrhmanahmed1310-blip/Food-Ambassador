-- CreateEnum
CREATE TYPE "SettlementKind" AS ENUM ('PAYMENT', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('POSTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'CHEQUE', 'CARD', 'OTHER');

-- CreateTable
CREATE TABLE "supplier_settlements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "SettlementKind" NOT NULL,
    "supplier_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "net_amount" DECIMAL(19,4),
    "tax_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "tax_code_id" UUID,
    "tax_rate" DECIMAL(9,6),
    "method" "PaymentMethod",
    "reference" TEXT,
    "supplier_document_no" TEXT,
    "note" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'POSTED',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_user_id" UUID,
    "void_reason" TEXT,

    CONSTRAINT "supplier_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_allocations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_settings" (
    "organization_id" UUID NOT NULL,
    "payables_account" TEXT,
    "purchases_account" TEXT,
    "input_vat_account" TEXT,
    "payments_account" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounting_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateIndex
CREATE INDEX "supplier_settlements_organization_id_supplier_id_date_idx" ON "supplier_settlements"("organization_id", "supplier_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_settlements_organization_id_id_key" ON "supplier_settlements"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_settlements_organization_id_number_key" ON "supplier_settlements"("organization_id", "number");

-- CreateIndex
CREATE INDEX "settlement_allocations_organization_id_invoice_id_idx" ON "settlement_allocations"("organization_id", "invoice_id");

-- CreateIndex
CREATE INDEX "settlement_allocations_organization_id_settlement_id_idx" ON "settlement_allocations"("organization_id", "settlement_id");

-- AddForeignKey
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_organization_id_tax_code_id_fkey" FOREIGN KEY ("organization_id", "tax_code_id") REFERENCES "tax_codes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_organization_id_settlement_id_fkey" FOREIGN KEY ("organization_id", "settlement_id") REFERENCES "supplier_settlements"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "supplier_invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-039) ───

ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_values_ck"
  CHECK ("amount" > 0 AND "tax_amount" >= 0
     AND (("kind" = 'PAYMENT') = ("method" IS NOT NULL))
     AND ("kind" = 'PAYMENT' OR ("net_amount" IS NOT NULL AND "amount" = "net_amount" + "tax_amount"))
     AND ("kind" = 'CREDIT_NOTE' OR ("net_amount" IS NULL AND "tax_amount" = 0 AND "tax_code_id" IS NULL))
     AND (("status" = 'VOIDED') = ("voided_at" IS NOT NULL)));
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_amount_ck" CHECK ("amount" > 0);

-- A supplier's credit note number is entered once (voided ones aside).
CREATE UNIQUE INDEX "supplier_settlements_credit_note_number" ON "supplier_settlements" ("organization_id", "supplier_id", "supplier_document_no")
  WHERE "kind" = 'CREDIT_NOTE' AND "status" <> 'VOIDED';

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "supplier_settlements" TO fa_tenant;
GRANT SELECT, INSERT ON "settlement_allocations" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "accounting_settings" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_settlements', 'settlement_allocations', 'accounting_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- A settlement is fixed once recorded; it can only be voided.
CREATE FUNCTION "supplier_settlement_void_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'POSTED' OR NEW."status" <> 'VOIDED'
     OR (to_jsonb(NEW) - ARRAY['status', 'voided_at', 'voided_by_user_id', 'void_reason'])
        <> (to_jsonb(OLD) - ARRAY['status', 'voided_at', 'voided_by_user_id', 'void_reason']) THEN
    RAISE EXCEPTION 'a supplier settlement can only be voided' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "supplier_settlements_void_only" BEFORE UPDATE ON "supplier_settlements"
  FOR EACH ROW EXECUTE FUNCTION "supplier_settlement_void_only"();

-- Allocations go from a posted settlement to a posted invoice of the same supplier.
CREATE FUNCTION "settlement_allocation_consistent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; i record;
BEGIN
  SELECT "supplier_id", "status" INTO s FROM "supplier_settlements" WHERE "id" = NEW."settlement_id";
  SELECT "supplier_id", "status" INTO i FROM "supplier_invoices" WHERE "id" = NEW."invoice_id";
  IF s."status" <> 'POSTED' OR i."status" <> 'POSTED' OR s."supplier_id" <> i."supplier_id" THEN
    RAISE EXCEPTION 'allocation must link a posted settlement and a posted invoice of the same supplier'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "settlement_allocations_consistent" BEFORE INSERT ON "settlement_allocations"
  FOR EACH ROW EXECUTE FUNCTION "settlement_allocation_consistent"();

-- ─── New permission for existing organizations' system roles ───
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('admin', 'payments.manage'), ('finance', 'payments.manage')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
