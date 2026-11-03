-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('DRAFT', 'SENT', 'AWARDED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'QUOTATION';

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "quotation_id" UUID;

-- CreateTable
CREATE TABLE "rfqs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "RfqStatus" NOT NULL DEFAULT 'DRAFT',
    "needed_by" DATE,
    "respond_by" DATE,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "sent_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "uom_id" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "note" TEXT,
    "awarded_quotation_line_id" UUID,
    "award_reason" TEXT,

    CONSTRAINT "rfq_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_suppliers" (
    "organization_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_suppliers_pkey" PRIMARY KEY ("organization_id","rfq_id","supplier_id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reference" TEXT,
    "quoted_on" DATE NOT NULL,
    "valid_until" DATE,
    "lead_time_days" INTEGER,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "rfq_line_id" UUID NOT NULL,
    "unit_price" DECIMAL(20,6) NOT NULL,
    "quantity" DECIMAL(20,6),
    "note" TEXT,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rfqs_organization_id_status_idx" ON "rfqs"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_organization_id_id_key" ON "rfqs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_organization_id_number_key" ON "rfqs"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_lines_organization_id_id_key" ON "rfq_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_lines_organization_id_rfq_id_line_no_key" ON "rfq_lines"("organization_id", "rfq_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_lines_organization_id_rfq_id_product_id_key" ON "rfq_lines"("organization_id", "rfq_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_lines_organization_id_awarded_quotation_line_id_key" ON "rfq_lines"("organization_id", "awarded_quotation_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organization_id_id_key" ON "quotations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organization_id_rfq_id_supplier_id_key" ON "quotations"("organization_id", "rfq_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_organization_id_id_key" ON "quotation_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_organization_id_quotation_id_rfq_line_id_key" ON "quotation_lines"("organization_id", "quotation_id", "rfq_line_id");

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_quotation_id_fkey" FOREIGN KEY ("organization_id", "quotation_id") REFERENCES "quotations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_organization_id_warehouse_id_fkey" FOREIGN KEY ("organization_id", "warehouse_id") REFERENCES "warehouses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_organization_id_rfq_id_fkey" FOREIGN KEY ("organization_id", "rfq_id") REFERENCES "rfqs"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_uom_id_fkey" FOREIGN KEY ("uom_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_organization_id_awarded_quotation_line_id_fkey" FOREIGN KEY ("organization_id", "awarded_quotation_line_id") REFERENCES "quotation_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_organization_id_rfq_id_fkey" FOREIGN KEY ("organization_id", "rfq_id") REFERENCES "rfqs"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_suppliers" ADD CONSTRAINT "rfq_suppliers_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organization_id_rfq_id_fkey" FOREIGN KEY ("organization_id", "rfq_id") REFERENCES "rfqs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organization_id_quotation_id_fkey" FOREIGN KEY ("organization_id", "quotation_id") REFERENCES "quotations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organization_id_rfq_line_id_fkey" FOREIGN KEY ("organization_id", "rfq_line_id") REFERENCES "rfq_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── C1b RFQs and quotations (ADR-092): hand-written rules ───

ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_title" CHECK (length(btrim("title")) > 0);
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_sent"
  CHECK (("sent_at" IS NULL) = ("sent_by_user_id" IS NULL)
     AND ("status" = 'DRAFT' OR "status" = 'CANCELLED' OR "sent_at" IS NOT NULL));
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_decided"
  CHECK (("status" IN ('AWARDED', 'CANCELLED')) = ("decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("decided_by_user_id" IS NULL)
     AND ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancel_reason", ''))) > 0));

ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_quantity" CHECK ("quantity" > 0);
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_price" CHECK ("unit_price" >= 0);
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quantity"
  CHECK ("quantity" IS NULL OR "quantity" > 0);
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_dates"
  CHECK ("valid_until" IS NULL OR "valid_until" >= "quoted_on");
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_lead_time"
  CHECK ("lead_time_days" IS NULL OR "lead_time_days" BETWEEN 0 AND 3650);

-- A quotation comes from an invited supplier; its lines answer lines of the
-- same RFQ; an award points at an offer for that very line.
CREATE FUNCTION quotation_supplier_invited() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "rfq_suppliers" s
                 WHERE s."organization_id" = NEW."organization_id"
                   AND s."rfq_id" = NEW."rfq_id" AND s."supplier_id" = NEW."supplier_id") THEN
    RAISE EXCEPTION 'quotation from a supplier not asked to quote' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "quotations_supplier_invited" BEFORE INSERT OR UPDATE OF "rfq_id", "supplier_id"
  ON "quotations" FOR EACH ROW EXECUTE FUNCTION quotation_supplier_invited();

CREATE FUNCTION quotation_line_same_rfq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "quotations" q JOIN "rfq_lines" l
                   ON l."organization_id" = q."organization_id" AND l."rfq_id" = q."rfq_id"
                 WHERE q."organization_id" = NEW."organization_id"
                   AND q."id" = NEW."quotation_id" AND l."id" = NEW."rfq_line_id") THEN
    RAISE EXCEPTION 'quotation line for another RFQ' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "quotation_lines_same_rfq" BEFORE INSERT OR UPDATE OF "quotation_id", "rfq_line_id"
  ON "quotation_lines" FOR EACH ROW EXECUTE FUNCTION quotation_line_same_rfq();

CREATE FUNCTION rfq_line_award_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."awarded_quotation_line_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "quotation_lines" q
       WHERE q."organization_id" = NEW."organization_id"
         AND q."id" = NEW."awarded_quotation_line_id" AND q."rfq_line_id" = NEW."id") THEN
    RAISE EXCEPTION 'award points at an offer for another line' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "rfq_lines_award_matches" BEFORE UPDATE OF "awarded_quotation_line_id"
  ON "rfq_lines" FOR EACH ROW EXECUTE FUNCTION rfq_line_award_matches();

GRANT SELECT, INSERT, UPDATE ON "rfqs" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "rfq_lines" TO fa_tenant;
GRANT SELECT, INSERT, DELETE ON "rfq_suppliers" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "quotations" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "quotation_lines" TO fa_tenant;
ALTER TABLE "rfqs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rfqs" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "rfq_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rfq_lines" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "rfq_suppliers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "rfq_suppliers" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "quotations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "quotations" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "quotation_lines" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "quotation_lines" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
