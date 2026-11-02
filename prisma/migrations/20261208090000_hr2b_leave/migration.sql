-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');


-- CreateTable
CREATE TABLE "leave_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "country" TEXT,
    "paid" BOOLEAN NOT NULL,
    "uses_balance" BOOLEAN NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_allocations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_user_id" UUID NOT NULL,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_organization_id_id_key" ON "leave_types"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_organization_id_code_key" ON "leave_types"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "leave_allocations_organization_id_employee_id_leave_type_id_key" ON "leave_allocations"("organization_id", "employee_id", "leave_type_id", "year");

-- CreateIndex
CREATE INDEX "leave_requests_organization_id_employee_id_start_date_idx" ON "leave_requests"("organization_id", "employee_id", "start_date");

-- CreateIndex
CREATE INDEX "leave_requests_organization_id_status_idx" ON "leave_requests"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_allocations" ADD CONSTRAINT "leave_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_allocations" ADD CONSTRAINT "leave_allocations_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_allocations" ADD CONSTRAINT "leave_allocations_organization_id_leave_type_id_fkey" FOREIGN KEY ("organization_id", "leave_type_id") REFERENCES "leave_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_leave_type_id_fkey" FOREIGN KEY ("organization_id", "leave_type_id") REFERENCES "leave_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (ADR-081) --------------------------------------------------------

ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_values_ck"
  CHECK (length("code") BETWEEN 1 AND 20 AND length("name") BETWEEN 1 AND 80
    AND ("country" IS NULL OR "country" ~ '^[A-Z]{2}$'));

ALTER TABLE "leave_allocations" ADD CONSTRAINT "leave_allocations_values_ck"
  CHECK ("year" BETWEEN 2000 AND 2100 AND "days" >= 0 AND "days" <= 366);

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_values_ck"
  CHECK ("end_date" >= "start_date" AND "days" > 0
    AND date_part('year', "start_date") = date_part('year', "end_date")
    AND ("status"::text = 'PENDING') = ("decided_at" IS NULL)
    AND ("decided_at" IS NULL) = ("decided_by_user_id" IS NULL));

-- Dates, type and days of a request never change; only its decision does.
CREATE TRIGGER "leave_requests_fixed" BEFORE UPDATE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION pos_fixed_except('status', 'decided_by_user_id', 'decided_at', 'decision_note');

GRANT SELECT, INSERT, UPDATE ON "leave_types" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "leave_allocations" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "leave_requests" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leave_types', 'leave_allocations', 'leave_requests']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
