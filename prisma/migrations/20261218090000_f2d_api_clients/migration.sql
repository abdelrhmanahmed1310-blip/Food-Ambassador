-- DropIndex

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- AlterTable

-- CreateTable
CREATE TABLE "api_clients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "company_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_user_id" UUID,

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_key_prefix_key" ON "api_clients"("key_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_organization_id_id_key" ON "api_clients"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_organization_id_company_id_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (ADR-090) --------------------------------------------------------
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_revoke_ck"
  CHECK (("revoked_at" IS NULL) = ("revoked_by_user_id" IS NULL));
GRANT SELECT, INSERT, UPDATE ON "api_clients" TO fa_tenant;
ALTER TABLE "api_clients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "api_clients" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
