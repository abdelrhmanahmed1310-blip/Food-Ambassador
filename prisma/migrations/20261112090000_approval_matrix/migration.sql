-- Approval matrix (ADR-049, Q-04 refined, Q-12): per-layer limits for
-- purchase orders and stock counts.

CREATE TYPE "ApprovalDocument" AS ENUM ('PURCHASE_ORDER', 'STOCK_COUNT');

CREATE TABLE "approval_layers" (
    "organization_id" UUID NOT NULL,
    "document" "ApprovalDocument" NOT NULL,
    "position" INTEGER NOT NULL,
    "above_amount" DECIMAL(19,4) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "approval_layers_pkey" PRIMARY KEY ("organization_id","document","position")
);
ALTER TABLE "approval_layers" ADD CONSTRAINT "approval_layers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approval_layers" ADD CONSTRAINT "approval_layers_values_ck"
  CHECK ("position" BETWEEN 1 AND 4 AND "above_amount" >= 0);

-- Existing settings become layers with the old limit on each layer.
INSERT INTO "approval_layers" ("organization_id", "document", "position", "above_amount", "updated_at")
SELECT s."organization_id", 'PURCHASE_ORDER', p, s."approval_threshold", now()
FROM "procurement_settings" s
CROSS JOIN LATERAL (
  SELECT generate_series(1, s."branch_approval_steps") AS p
  UNION ALL SELECT 4 WHERE s."head_office_approval" OR s."branch_approval_steps" = 0
) layers
WHERE s."approval_threshold" IS NOT NULL;

-- Orders: the chain fixed at submission becomes an explicit list.
ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_approval_chain_ck";
ALTER TABLE "purchase_orders" ADD COLUMN "approval_chain" "ApprovalLevel"[] NOT NULL DEFAULT ARRAY[]::"ApprovalLevel"[];
UPDATE "purchase_orders" SET "approval_chain" =
  CASE WHEN "branch_approvals_required" = 0 AND NOT "head_office_approval_required"
       THEN (CASE WHEN "approval_round" > 0 AND NOT "auto_approved" THEN ARRAY['ANY']::"ApprovalLevel"[] ELSE ARRAY[]::"ApprovalLevel"[] END)
       ELSE array_fill('BRANCH'::"ApprovalLevel", ARRAY["branch_approvals_required"])
            || (CASE WHEN "head_office_approval_required" THEN ARRAY['HEAD_OFFICE']::"ApprovalLevel"[] ELSE ARRAY[]::"ApprovalLevel"[] END)
  END;
ALTER TABLE "purchase_orders" DROP COLUMN "branch_approvals_required",
  DROP COLUMN "head_office_approval_required";
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approval_chain_ck"
  CHECK ("approval_round" >= 0 AND "approvals_given" >= 0
         AND "approvals_given" <= cardinality("approval_chain")
         AND ("pending_approval_level" IS NULL OR "status" = 'PENDING_APPROVAL'));

ALTER TABLE "procurement_settings" DROP CONSTRAINT "procurement_settings_approval_steps_ck";
ALTER TABLE "procurement_settings" DROP COLUMN "approval_threshold",
  DROP COLUMN "branch_approval_steps",
  DROP COLUMN "head_office_approval";

-- Stock counts get the same chain (Q-12).
ALTER TABLE "stock_counts" ADD COLUMN "approval_chain" "ApprovalLevel"[] NOT NULL DEFAULT ARRAY[]::"ApprovalLevel"[],
  ADD COLUMN "approval_round" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "approvals_given" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pending_approval_level" "ApprovalLevel",
  ADD COLUMN "rejection_note" TEXT,
  ADD COLUMN "variance_value" DECIMAL(19,4);
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_approval_chain_ck"
  CHECK ("approval_round" >= 0 AND "approvals_given" >= 0
         AND "approvals_given" <= cardinality("approval_chain")
         AND ("variance_value" IS NULL OR "variance_value" >= 0)
         AND ("pending_approval_level" IS NULL OR "status" = 'SUBMITTED'));

CREATE TABLE "stock_count_approvals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "level" "ApprovalLevel" NOT NULL,
    "approved_by_user_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_count_approvals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "count_approvals_step_key" ON "stock_count_approvals"("organization_id", "count_id", "round", "step");
CREATE UNIQUE INDEX "count_approvals_person_key" ON "stock_count_approvals"("organization_id", "count_id", "round", "approved_by_user_id");
ALTER TABLE "stock_count_approvals" ADD CONSTRAINT "stock_count_approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_count_approvals" ADD CONSTRAINT "stock_count_approvals_organization_id_count_id_fkey" FOREIGN KEY ("organization_id", "count_id") REFERENCES "stock_counts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_count_approvals" ADD CONSTRAINT "stock_count_approvals_values_ck"
  CHECK ("round" >= 1 AND "step" BETWEEN 1 AND 4);

-- Nobody approves a count they created or submitted.
CREATE FUNCTION "count_approval_not_author"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  SELECT "created_by_user_id", "submitted_by_user_id", "approval_round", "status"
    INTO c FROM "stock_counts"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."count_id";
  IF NEW."approved_by_user_id" = c."created_by_user_id"
     OR NEW."approved_by_user_id" = c."submitted_by_user_id" THEN
    RAISE EXCEPTION 'stock count approved by its author' USING ERRCODE = 'check_violation';
  END IF;
  IF c."status" <> 'SUBMITTED' OR NEW."round" <> c."approval_round" THEN
    RAISE EXCEPTION 'stock count is not waiting for this approval' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "count_approval_not_author" BEFORE INSERT ON "stock_count_approvals"
  FOR EACH ROW EXECUTE FUNCTION "count_approval_not_author"();

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE, DELETE ON "approval_layers" TO fa_tenant;
GRANT SELECT, INSERT ON "stock_count_approvals" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_layers', 'stock_count_approvals']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
