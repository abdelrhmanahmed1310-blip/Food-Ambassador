-- CreateTable
CREATE TABLE "customer_segments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "customer_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_feedback" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pos_order_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by_user_id" UUID,
    "review_note" TEXT,
    "complaint_id" UUID,

    CONSTRAINT "guest_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_segments_organization_id_id_key" ON "customer_segments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_segments_organization_id_name_key" ON "customer_segments"("organization_id", "name");

-- CreateIndex
CREATE INDEX "guest_feedback_organization_id_branch_id_submitted_at_idx" ON "guest_feedback"("organization_id", "branch_id", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "guest_feedback_organization_id_id_key" ON "guest_feedback"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_feedback_organization_id_pos_order_id_key" ON "guest_feedback"("organization_id", "pos_order_id");

-- AddForeignKey
ALTER TABLE "customer_segments" ADD CONSTRAINT "customer_segments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_feedback" ADD CONSTRAINT "guest_feedback_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_feedback" ADD CONSTRAINT "guest_feedback_organization_id_pos_order_id_fkey" FOREIGN KEY ("organization_id", "pos_order_id") REFERENCES "pos_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_feedback" ADD CONSTRAINT "guest_feedback_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_feedback" ADD CONSTRAINT "guest_feedback_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "pos_customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_feedback" ADD CONSTRAINT "guest_feedback_organization_id_complaint_id_fkey" FOREIGN KEY ("organization_id", "complaint_id") REFERENCES "complaints"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C7c segments and feedback (ADR-118): hand-written rules ───
ALTER TABLE "guest_feedback" ADD CONSTRAINT "guest_feedback_ck" CHECK (
  "rating" BETWEEN 1 AND 5 AND ("comment" IS NULL OR length("comment") <= 1000));
-- The guest's words never change; only the review fields do.
CREATE OR REPLACE FUNCTION "guest_feedback_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."rating" <> OLD."rating" OR NEW."comment" IS DISTINCT FROM OLD."comment"
     OR NEW."pos_order_id" <> OLD."pos_order_id" OR NEW."submitted_at" <> OLD."submitted_at" THEN
    RAISE EXCEPTION 'guest feedback cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "guest_feedback_fixed" BEFORE UPDATE ON "guest_feedback"
  FOR EACH ROW EXECUTE FUNCTION "guest_feedback_fixed"();

GRANT SELECT, INSERT, UPDATE ON "customer_segments", "guest_feedback" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_segments', 'guest_feedback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;
