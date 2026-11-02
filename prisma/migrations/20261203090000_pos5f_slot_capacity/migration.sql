
-- AlterTable
ALTER TABLE "ordering_channels" ADD COLUMN     "slot_capacity" INTEGER;


ALTER TABLE "ordering_channels" ADD CONSTRAINT "ordering_channels_capacity_ck"
  CHECK ("slot_capacity" IS NULL OR "slot_capacity" BETWEEN 1 AND 500);
