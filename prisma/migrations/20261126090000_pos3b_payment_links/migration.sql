-- CreateEnum
CREATE TYPE "PaymentProviderMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "PaymentLinkStatus" AS ENUM ('CREATED', 'PAID', 'RECORDED', 'FAILED', 'CANCELLED');

-- DropIndex

-- CreateTable
CREATE TABLE "payment_provider_settings" (
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MOYASAR',
    "mode" "PaymentProviderMode" NOT NULL DEFAULT 'TEST',
    "secret_key_sealed" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_provider_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "payment_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_invoice_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "tab_id" UUID NOT NULL,
    "register_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'CREATED',
    "provider_payment_id" TEXT,
    "problem" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_links_organization_id_tab_id_idx" ON "payment_links"("organization_id", "tab_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_organization_id_provider_invoice_id_key" ON "payment_links"("organization_id", "provider_invoice_id");

-- AddForeignKey
ALTER TABLE "payment_provider_settings" ADD CONSTRAINT "payment_provider_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules, access and row-level security (ADR-066) ───
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_values_ck"
  CHECK ("amount" > 0
     AND (("status" IN ('PAID', 'RECORDED')) = ("paid_at" IS NOT NULL)));
GRANT SELECT, INSERT, UPDATE ON "payment_provider_settings", "payment_links" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_provider_settings', 'payment_links']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
