-- ADR-147: plans and prices entered by the platform operator, and monthly statements.
ALTER TABLE "organizations" ADD COLUMN     "billing_plan_id" UUID,
ADD COLUMN     "billing_plan_since" DATE;
CREATE TABLE "billing_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "monthly_fee" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "pricing" JSONB NOT NULL DEFAULT '{}',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "billing_statements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "plan" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "total" DECIMAL(19,4) NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_at" TIMESTAMPTZ(3),
    "issued_by" TEXT,
    CONSTRAINT "billing_statements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_plans_code_key" ON "billing_plans"("code");
CREATE UNIQUE INDEX "billing_statements_organization_id_month_key" ON "billing_statements"("organization_id", "month");
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_billing_plan_id_fkey" FOREIGN KEY ("billing_plan_id") REFERENCES "billing_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_statements" ADD CONSTRAINT "billing_statements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (ADR-147) --------------------------------------------------------
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_fee_check" CHECK ("monthly_fee" >= 0);
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_pricing_check" CHECK (jsonb_typeof("pricing") = 'object');
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$');
ALTER TABLE "billing_statements" ADD CONSTRAINT "billing_statements_month_check" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "billing_statements" ADD CONSTRAINT "billing_statements_status_check" CHECK ("status" IN ('DRAFT', 'ISSUED'));
ALTER TABLE "billing_statements" ADD CONSTRAINT "billing_statements_issued_check"
  CHECK (("status" = 'ISSUED') = ("issued_at" IS NOT NULL AND "issued_by" IS NOT NULL));
ALTER TABLE "billing_statements" ADD CONSTRAINT "billing_statements_total_check" CHECK ("total" >= 0);
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_billing_plan_check"
  CHECK (("billing_plan_id" IS NULL) = ("billing_plan_since" IS NULL));

-- An issued statement is fixed.
CREATE FUNCTION "billing_statements_issued_fixed"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'ISSUED' THEN
    RAISE EXCEPTION 'An issued statement cannot be changed or removed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "billing_statements_issued_fixed" BEFORE UPDATE OR DELETE ON "billing_statements"
  FOR EACH ROW EXECUTE FUNCTION "billing_statements_issued_fixed"();

-- Plans belong to the platform: the tenant role may only read them (its own plan's name).
GRANT SELECT ON "billing_plans" TO fa_tenant;
ALTER TABLE "billing_plans" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "readable" ON "billing_plans" FOR SELECT USING (true);
-- Statements are written by the platform (system role) and read by their organization.
GRANT SELECT ON "billing_statements" TO fa_tenant;
ALTER TABLE "billing_statements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "billing_statements" USING ("organization_id" = current_organization_id());
