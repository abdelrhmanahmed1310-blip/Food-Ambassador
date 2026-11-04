-- CreateEnum
CREATE TYPE "CampaignChannel" AS ENUM ('SMS', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "CampaignChannel" NOT NULL,
    "segment_id" UUID NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "skip_if_messaged_within_days" INTEGER,
    "attribution_days" INTEGER NOT NULL DEFAULT 7,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMPTZ(3),
    "launched_at" TIMESTAMPTZ(3),
    "launched_by_user_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "skip_reason" TEXT,
    "provider_message_id" TEXT,
    "error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "opted_out_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_organization_id_status_scheduled_at_idx" ON "campaigns"("organization_id", "status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_organization_id_id_key" ON "campaigns"("organization_id", "id");

-- CreateIndex
CREATE INDEX "campaign_recipients_organization_id_customer_id_sent_at_idx" ON "campaign_recipients"("organization_id", "customer_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_organization_id_id_key" ON "campaign_recipients"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_organization_id_campaign_id_customer_id_key" ON "campaign_recipients"("organization_id", "campaign_id", "customer_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_segment_id_fkey" FOREIGN KEY ("organization_id", "segment_id") REFERENCES "customer_segments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "pos_customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── C7d campaigns (ADR-119): hand-written rules ───
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_ck" CHECK (
  length("body") BETWEEN 1 AND 2000
  AND ("channel" <> 'EMAIL' OR "subject" IS NOT NULL)
  AND ("skip_if_messaged_within_days" IS NULL OR "skip_if_messaged_within_days" BETWEEN 1 AND 365)
  AND "attribution_days" BETWEEN 1 AND 60
  AND ("status" <> 'SCHEDULED' OR "scheduled_at" IS NOT NULL));
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_ck" CHECK (
  ("status" <> 'SKIPPED' OR "skip_reason" IS NOT NULL) AND ("status" <> 'SENT' OR "sent_at" IS NOT NULL));

GRANT SELECT, INSERT, UPDATE ON "campaigns", "campaign_recipients" TO fa_tenant;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'campaign_recipients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "tenant_isolation" ON %I USING ("organization_id" = current_organization_id()) WITH CHECK ("organization_id" = current_organization_id())', t);
  END LOOP;
END $$;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission")
SELECT r."organization_id", r."id", p.permission
FROM "roles" r
JOIN (VALUES ('admin', 'campaigns.send'), ('operations_manager', 'campaigns.send'))
  AS p(role_key, permission) ON p.role_key = r."key"
WHERE r."is_system"
ON CONFLICT DO NOTHING;
