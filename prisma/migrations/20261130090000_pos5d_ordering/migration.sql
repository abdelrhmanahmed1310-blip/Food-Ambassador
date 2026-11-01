-- CreateEnum
CREATE TYPE "PosTabSource" AS ENUM ('STAFF', 'WEB', 'KIOSK');

-- CreateEnum
CREATE TYPE "OrderingChannelKind" AS ENUM ('WEB', 'KIOSK');


-- AlterTable
ALTER TABLE "pos_tabs" ADD COLUMN     "guest_name" TEXT,
ADD COLUMN     "guest_phone" TEXT,
ADD COLUMN     "guest_token" TEXT,
ADD COLUMN     "source" "PosTabSource" NOT NULL DEFAULT 'STAFF',
ADD COLUMN     "source_channel_id" UUID,
ADD COLUMN     "source_key" TEXT;

-- CreateTable
CREATE TABLE "ordering_channels" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "OrderingChannelKind" NOT NULL,
    "name" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "channels" "SalesChannel"[],
    "auto_send" BOOLEAN NOT NULL DEFAULT false,
    "max_order_total" DECIMAL(19,4),
    "public_token" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "ordering_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ordering_channels_public_token_key" ON "ordering_channels"("public_token");

-- CreateIndex
CREATE UNIQUE INDEX "ordering_channels_organization_id_id_key" ON "ordering_channels"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tabs_guest_token_key" ON "pos_tabs"("guest_token");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tabs_organization_id_source_channel_id_source_key_key" ON "pos_tabs"("organization_id", "source_channel_id", "source_key");

-- AddForeignKey
ALTER TABLE "ordering_channels" ADD CONSTRAINT "ordering_channels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordering_channels" ADD CONSTRAINT "ordering_channels_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tabs" ADD CONSTRAINT "pos_tabs_organization_id_source_channel_id_fkey" FOREIGN KEY ("organization_id", "source_channel_id") REFERENCES "ordering_channels"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written: rules, access and row-level security (ADR-070) ───
ALTER TABLE "ordering_channels" ADD CONSTRAINT "ordering_channels_values_ck"
  CHECK (length("name") BETWEEN 1 AND 120 AND "public_token" ~ '^[A-Za-z0-9_-]{24,64}$'
     AND cardinality("channels") > 0
     AND ("kind" <> 'WEB' OR "channels" <@ ARRAY['TAKEAWAY', 'DELIVERY']::"SalesChannel"[])
     AND ("max_order_total" IS NULL OR "max_order_total" > 0));
-- A guest's check names its channel and the guest; a staff check has neither.
ALTER TABLE "pos_tabs" ADD CONSTRAINT "pos_tabs_source_ck"
  CHECK ((("source" = 'STAFF') = ("source_channel_id" IS NULL))
     AND ("source" = 'STAFF' OR ("source_key" IS NOT NULL AND "guest_token" IS NOT NULL
                                 AND "guest_name" IS NOT NULL))
     AND ("guest_name" IS NULL OR length("guest_name") BETWEEN 1 AND 60)
     AND ("guest_phone" IS NULL OR "guest_phone" ~ '^\+[1-9][0-9]{7,14}$')
     AND ("guest_token" IS NULL OR "guest_token" ~ '^[A-Za-z0-9_-]{24,64}$'));

GRANT SELECT, INSERT, UPDATE ON "ordering_channels" TO fa_tenant;
ALTER TABLE "ordering_channels" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ordering_channels"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
