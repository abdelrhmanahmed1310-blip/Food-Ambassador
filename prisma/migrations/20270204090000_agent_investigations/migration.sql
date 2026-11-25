-- ADR-148: Claude investigates agent findings.
CREATE TABLE "agent_investigations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "finding_index" INTEGER NOT NULL,
    "finding_code" TEXT NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "model" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_investigations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_investigations_organization_id_run_id_finding_index_c_idx" ON "agent_investigations"("organization_id", "run_id", "finding_index", "created_at");
ALTER TABLE "agent_investigations" ADD CONSTRAINT "agent_investigations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_investigations" ADD CONSTRAINT "agent_investigations_organization_id_run_id_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "agent_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (ADR-148) --------------------------------------------------------
ALTER TABLE "agent_investigations" ADD CONSTRAINT "agent_investigations_status_check"
  CHECK ("status" IN ('OK', 'FAILED'));
ALTER TABLE "agent_investigations" ADD CONSTRAINT "agent_investigations_result_check"
  CHECK (("status" = 'OK') = ("result" IS NOT NULL));
ALTER TABLE "agent_investigations" ADD CONSTRAINT "agent_investigations_numbers_check"
  CHECK ("finding_index" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0);
GRANT SELECT, INSERT ON "agent_investigations" TO fa_tenant;
ALTER TABLE "agent_investigations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agent_investigations" USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
