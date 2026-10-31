-- CreateEnum
CREATE TYPE "ApprovalLevel" AS ENUM ('BRANCH', 'HEAD_OFFICE', 'ANY');

-- AlterTable
ALTER TABLE "procurement_settings" ADD COLUMN     "branch_approval_steps" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "head_office_approval" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "approval_round" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "approvals_given" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "branch_approvals_required" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "head_office_approval_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pending_approval_level" "ApprovalLevel";

-- CreateTable
CREATE TABLE "purchase_order_approvals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "level" "ApprovalLevel" NOT NULL,
    "approved_by_user_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "po_approvals_step_key" ON "purchase_order_approvals"("organization_id", "purchase_order_id", "round", "step");

-- CreateIndex
CREATE UNIQUE INDEX "po_approvals_person_key" ON "purchase_order_approvals"("organization_id", "purchase_order_id", "round", "approved_by_user_id");

-- AddForeignKey
ALTER TABLE "purchase_order_approvals" ADD CONSTRAINT "purchase_order_approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_approvals" ADD CONSTRAINT "purchase_order_approvals_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-049) ───

ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_approval_steps_ck"
  CHECK ("branch_approval_steps" BETWEEN 0 AND 3);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approval_chain_ck"
  CHECK ("approval_round" >= 0 AND "branch_approvals_required" BETWEEN 0 AND 3
         AND "approvals_given" >= 0
         AND ("pending_approval_level" IS NULL OR "status" = 'PENDING_APPROVAL'));
ALTER TABLE "purchase_order_approvals" ADD CONSTRAINT "purchase_order_approvals_values_ck"
  CHECK ("round" >= 1 AND "step" BETWEEN 1 AND 4);

-- Nobody approves an order they created or submitted, whatever the code path.
CREATE FUNCTION "po_approval_not_author"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record;
BEGIN
  SELECT "created_by_user_id", "submitted_by_user_id", "approval_round", "status"
    INTO o FROM "purchase_orders"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."purchase_order_id";
  IF NEW."approved_by_user_id" = o."created_by_user_id"
     OR NEW."approved_by_user_id" = o."submitted_by_user_id" THEN
    RAISE EXCEPTION 'purchase order approved by its author' USING ERRCODE = 'check_violation';
  END IF;
  IF o."status" <> 'PENDING_APPROVAL' OR NEW."round" <> o."approval_round" THEN
    RAISE EXCEPTION 'purchase order is not waiting for this approval' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "po_approval_not_author" BEFORE INSERT ON "purchase_order_approvals"
  FOR EACH ROW EXECUTE FUNCTION "po_approval_not_author"();

-- ─── Row-level security and grants (insert-only history) ───

GRANT SELECT, INSERT ON "purchase_order_approvals" TO fa_tenant;
ALTER TABLE "purchase_order_approvals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "purchase_order_approvals"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

-- Branch managers sign the branch steps (ADR-049).
-- Mirrors SYSTEM_ROLE_TEMPLATES in src/modules/access/permissions.ts.
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES
  ('branch_manager', 'purchasing.approve')
) AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
