-- CreateEnum
CREATE TYPE "ConnectorKind" AS ENUM ('INBOUND_SALES_WEBHOOK', 'OUTBOUND_WEBHOOK');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "InboundEventStatus" AS ENUM ('ACCEPTED', 'REJECTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "DeliveryAttemptStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "connectors" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "ConnectorKind" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB NOT NULL,
    "public_id" TEXT NOT NULL,
    "secret_sealed" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "secret_rotated_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "idempotency_key" TEXT,
    "status" "InboundEventStatus" NOT NULL,
    "outcome" JSONB NOT NULL,
    "body_sha256" TEXT NOT NULL,
    "body_bytes" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeliveryAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connectors_public_id_key" ON "connectors"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "connectors_organization_id_id_key" ON "connectors"("organization_id", "id");

-- CreateIndex
CREATE INDEX "integration_events_organization_id_connector_id_received_at_idx" ON "integration_events"("organization_id", "connector_id", "received_at");

-- CreateIndex
CREATE INDEX "outbound_deliveries_status_next_attempt_at_idx" ON "outbound_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_deliveries_organization_id_connector_id_event_key_key" ON "outbound_deliveries"("organization_id", "connector_id", "event_key");

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_organization_id_connector_id_fkey" FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_organization_id_connector_id_fkey" FOREIGN KEY ("organization_id", "connector_id") REFERENCES "connectors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Checks (ADR-048) ───

ALTER TABLE "connectors" ADD CONSTRAINT "connectors_values_ck"
  CHECK (length("name") BETWEEN 1 AND 120 AND "public_id" ~ '^[A-Za-z0-9_-]{24,64}$' AND "secret_sealed" LIKE 'v1.%');
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_values_ck"
  CHECK ("attempts" >= 0 AND (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL)));
CREATE UNIQUE INDEX "integration_events_idempotency" ON "integration_events" ("organization_id", "connector_id", "idempotency_key")
  WHERE "status" = 'ACCEPTED';

-- ─── Row-level security and grants ───

GRANT SELECT, INSERT, UPDATE ON "connectors", "outbound_deliveries" TO fa_tenant;
GRANT SELECT, INSERT ON "integration_events" TO fa_tenant;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connectors', 'integration_events', 'outbound_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END
$$;
