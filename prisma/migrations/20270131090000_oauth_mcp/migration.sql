-- ADR-144: OAuth 2.1 for the MCP server.
-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_grants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "scopes" TEXT[],
    "resource" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_user_id" UUID,

    CONSTRAINT "oauth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_codes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- CreateIndex
CREATE INDEX "oauth_grants_organization_id_user_id_idx" ON "oauth_grants"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_grants_organization_id_id_key" ON "oauth_grants"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_codes_code_hash_key" ON "oauth_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_token_hash_key" ON "oauth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "oauth_tokens_organization_id_grant_id_idx" ON "oauth_tokens"("organization_id", "grant_id");

-- AddForeignKey
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_organization_id_grant_id_fkey" FOREIGN KEY ("organization_id", "grant_id") REFERENCES "oauth_grants"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_organization_id_grant_id_fkey" FOREIGN KEY ("organization_id", "grant_id") REFERENCES "oauth_grants"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (ADR-144) --------------------------------------------------------
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_redirects_ck"
  CHECK (cardinality("redirect_uris") BETWEEN 1 AND 10);
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_scopes_ck"
  CHECK (cardinality("scopes") >= 1 AND "scopes" <@ ARRAY['mcp:read', 'mcp:decide']::text[]);
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_revoke_ck"
  CHECK ("revoked_by_user_id" IS NULL OR "revoked_at" IS NOT NULL);
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_kind_ck" CHECK ("kind" IN ('ACCESS', 'REFRESH'));

-- Registered apps are not tenant data: only the system role reads them.
ALTER TABLE "oauth_clients" ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON "oauth_clients" TO fa_tenant;
CREATE POLICY "readable" ON "oauth_clients" FOR SELECT USING (true);

GRANT SELECT, INSERT, UPDATE ON "oauth_grants", "oauth_codes", "oauth_tokens" TO fa_tenant;
ALTER TABLE "oauth_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "oauth_grants" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "oauth_codes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "oauth_codes" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
ALTER TABLE "oauth_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "oauth_tokens" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
