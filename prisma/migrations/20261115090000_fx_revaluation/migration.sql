-- CreateTable
CREATE TABLE "fx_revaluations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "as_of" DATE NOT NULL,
    "total_difference_base" DECIMAL(19,4) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "fx_revaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_revaluation_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "revaluation_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "open_amount" DECIMAL(19,4) NOT NULL,
    "booked_base" DECIMAL(19,4) NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "rate_date" DATE NOT NULL,
    "revalued_base" DECIMAL(19,4) NOT NULL,
    "difference_base" DECIMAL(19,4) NOT NULL,

    CONSTRAINT "fx_revaluation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fx_revaluations_organization_id_id_key" ON "fx_revaluations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fx_revaluations_organization_id_number_key" ON "fx_revaluations"("organization_id", "number");

-- CreateIndex
CREATE INDEX "fx_revaluation_lines_organization_id_revaluation_id_idx" ON "fx_revaluation_lines"("organization_id", "revaluation_id");

-- AddForeignKey
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_revaluation_lines" ADD CONSTRAINT "fx_revaluation_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_revaluation_lines" ADD CONSTRAINT "fx_revaluation_lines_organization_id_revaluation_id_fkey" FOREIGN KEY ("organization_id", "revaluation_id") REFERENCES "fx_revaluations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fx_revaluation_lines" ADD CONSTRAINT "fx_revaluation_lines_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Rules (ADR-052) ───

-- One revaluation per date unless cancelled.
CREATE UNIQUE INDEX "fx_revaluations_as_of" ON "fx_revaluations" ("organization_id", "as_of")
  WHERE "cancelled_at" IS NULL;
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_cancel_ck"
  CHECK (("cancelled_at" IS NULL) = ("cancelled_by_user_id" IS NULL)
         AND ("cancelled_at" IS NULL OR "cancel_reason" IS NOT NULL));
ALTER TABLE "fx_revaluation_lines" ADD CONSTRAINT "fx_revaluation_lines_values_ck"
  CHECK ("rate" > 0 AND "currency" ~ '^[A-Z]{3}$'
         AND "difference_base" = "revalued_base" - "booked_base");

-- A revaluation is fixed once stored; it can only be cancelled. Lines are insert-only.
CREATE FUNCTION "fx_revaluation_cancel_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."cancelled_at" IS NOT NULL OR NEW."cancelled_at" IS NULL
     OR (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by_user_id', 'cancel_reason'])
        <> (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by_user_id', 'cancel_reason']) THEN
    RAISE EXCEPTION 'a revaluation can only be cancelled' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "fx_revaluations_cancel_only" BEFORE UPDATE ON "fx_revaluations"
  FOR EACH ROW EXECUTE FUNCTION "fx_revaluation_cancel_only"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "fx_revaluations" TO fa_tenant;
GRANT SELECT, INSERT ON "fx_revaluation_lines" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fx_revaluations', 'fx_revaluation_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
