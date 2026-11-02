-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "EmployeeDocumentType" AS ENUM ('NATIONAL_ID', 'IQAMA', 'PASSPORT', 'WORK_PERMIT', 'HEALTH_CERTIFICATE', 'DRIVING_LICENSE', 'CONTRACT', 'OTHER');


-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "parent_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "name_ar" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "nationality" TEXT,
    "national_id" TEXT,
    "job_title" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID,
    "manager_id" UUID,
    "employment_type" "EmploymentType" NOT NULL,
    "hire_date" DATE NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "terminated_on" DATE,
    "termination_reason" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "EmployeeDocumentType" NOT NULL,
    "number" TEXT,
    "issued_on" DATE,
    "expires_on" DATE,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_organization_id_id_key" ON "departments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_organization_id_code_key" ON "departments"("organization_id", "code");

-- CreateIndex
CREATE INDEX "employees_organization_id_branch_id_status_idx" ON "employees"("organization_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employees_organization_id_id_key" ON "employees"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_organization_id_number_key" ON "employees"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "employees_organization_id_user_id_key" ON "employees"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "employee_documents_organization_id_expires_on_idx" ON "employee_documents"("organization_id", "expires_on");

-- CreateIndex
CREATE INDEX "employee_documents_organization_id_employee_id_idx" ON "employee_documents"("organization_id", "employee_id");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_parent_id_fkey" FOREIGN KEY ("organization_id", "parent_id") REFERENCES "departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_department_id_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_manager_id_fkey" FOREIGN KEY ("organization_id", "manager_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written (ADR-079) --------------------------------------------------------
-- New enum values are compared as text in this migration.

ALTER TABLE "departments" ADD CONSTRAINT "departments_values_ck"
  CHECK (length("code") BETWEEN 1 AND 20 AND length("name") BETWEEN 1 AND 120
    AND ("parent_id" IS NULL OR "parent_id" <> "id"));

ALTER TABLE "employees" ADD CONSTRAINT "employees_values_ck"
  CHECK (length("number") BETWEEN 1 AND 30
    AND length("first_name") BETWEEN 1 AND 80 AND length("last_name") BETWEEN 1 AND 80
    AND length("job_title") BETWEEN 1 AND 120
    AND ("nationality" IS NULL OR "nationality" ~ '^[A-Z]{2}$')
    AND ("manager_id" IS NULL OR "manager_id" <> "id")
    AND ("status"::text = 'TERMINATED') = ("terminated_on" IS NOT NULL)
    AND ("terminated_on" IS NULL OR "terminated_on" >= "hire_date"));

ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_values_ck"
  CHECK (("number" IS NULL OR length("number") BETWEEN 1 AND 60)
    AND ("expires_on" IS NULL OR "issued_on" IS NULL OR "expires_on" >= "issued_on"));

GRANT SELECT, INSERT, UPDATE ON "departments" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE ON "employees" TO fa_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_documents" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['departments', 'employees', 'employee_documents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;

-- Existing organizations' system roles get the new HR permissions (as new ones do).
INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'hr.view'), ('admin', 'hr.manage'),
             ('operations_manager', 'hr.view'),
             ('branch_manager', 'hr.view'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
