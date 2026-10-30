import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { decimalString } from "@/lib/decimal";
import {
  idempotencyKeySchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import { MANUAL_STATUSES } from "./rules";

export const ADJUSTMENT_REASONS = [
  "DATA_CORRECTION",
  "FOUND_STOCK",
  "UNIT_ERROR",
  "OTHER",
] as const;
export const WRITE_OFF_REASONS = [
  "EXPIRED",
  "DAMAGED",
  "SPOILED",
  "CONTAMINATED",
  "RECALLED",
  "OTHER",
] as const;
export const STATUS_REASONS = [
  "QUALITY_CHECK",
  "TEMPERATURE_EXCURSION",
  "PACKAGING_DAMAGE",
  "SUPPLIER_ISSUE",
  "RECALL_INVESTIGATION",
  "RELEASED_AFTER_INSPECTION",
  "OTHER",
] as const;
export const REVALUATION_REASONS = [
  "MISSING_COST",
  "COST_CORRECTION",
  "SUPPLIER_PRICE_CHANGE",
  "OTHER",
] as const;
export const REVERSAL_REASONS = [
  "ENTERED_IN_ERROR",
  "WRONG_QUANTITY",
  "WRONG_ITEM_OR_LOT",
  "OTHER",
] as const;

const dateSchema = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || isCalendarDate(v), {
    error: "invalidDate",
  });

const lotCodeSchema = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim().toUpperCase() : undefined))
  .refine((v) => v === undefined || /^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(v), {
    error: "invalidLotCode",
  });

const quantitySchema = decimalString({ maxScale: 6, min: "0.000001" });
const unitCostSchema = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .pipe(decimalString({ maxScale: 6, min: "0" }).optional());
const statusSchema = z.enum(MANUAL_STATUSES, { error: "invalidOption" });

/** "OTHER" reasons need an explanatory note. */
function requireNoteForOther<T extends { reasonCode: string; note?: string }>(
  v: T,
  ctx: z.RefinementCtx,
) {
  if (v.reasonCode === "OTHER" && !v.note)
    ctx.addIssue({ code: "custom", path: ["note"], message: "noteRequired" });
}

/** Where stock is: one balance bucket. */
const bucketFields = {
  warehouseId: uuidSchema,
  locationId: optionalUuidSchema,
  productId: uuidSchema,
  lotId: optionalUuidSchema,
};

/** Stock coming in: the lot is identified by code (created if new). */
export const openingBalanceSchema = z.object({
  warehouseId: uuidSchema,
  locationId: optionalUuidSchema,
  productId: uuidSchema,
  lotCode: lotCodeSchema,
  expiresOn: dateSchema,
  bestBeforeOn: dateSchema,
  quantity: quantitySchema,
  uomId: uuidSchema,
  unitCost: unitCostSchema,
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});
export type OpeningBalanceInput = z.input<typeof openingBalanceSchema>;

export const adjustmentSchema = z
  .object({
    warehouseId: uuidSchema,
    locationId: optionalUuidSchema,
    productId: uuidSchema,
    lotCode: lotCodeSchema,
    expiresOn: dateSchema,
    direction: z.enum(["INCREASE", "DECREASE"], { error: "invalidOption" }),
    stockStatus: statusSchema.default("AVAILABLE"),
    quantity: quantitySchema,
    uomId: uuidSchema,
    reasonCode: z.enum(ADJUSTMENT_REASONS, { error: "invalidOption" }),
    note: optionalText(500),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(requireNoteForOther);

export const writeOffSchema = z
  .object({
    ...bucketFields,
    stockStatus: statusSchema,
    quantity: quantitySchema,
    uomId: uuidSchema,
    reasonCode: z.enum(WRITE_OFF_REASONS, { error: "invalidOption" }),
    note: optionalText(500),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(requireNoteForOther);

export const transferSchema = z.object({
  ...bucketFields,
  toWarehouseId: uuidSchema,
  toLocationId: optionalUuidSchema,
  quantity: quantitySchema,
  uomId: uuidSchema,
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

export const statusChangeSchema = z
  .object({
    ...bucketFields,
    fromStatus: statusSchema,
    toStatus: statusSchema,
    quantity: quantitySchema,
    uomId: uuidSchema,
    reasonCode: z.enum(STATUS_REASONS, { error: "invalidOption" }),
    note: optionalText(500),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(requireNoteForOther);

/** New average cost per base unit for a product in a warehouse (ADR-021). */
export const revaluationSchema = z
  .object({
    warehouseId: uuidSchema,
    productId: uuidSchema,
    unitCost: decimalString({ maxScale: 6, min: "0" }),
    reasonCode: z.enum(REVALUATION_REASONS, { error: "invalidOption" }),
    note: optionalText(500),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine(requireNoteForOther);

export const reversalSchema = z
  .object({
    reasonCode: z.enum(REVERSAL_REASONS, { error: "invalidOption" }),
    note: optionalText(500),
  })
  .superRefine(requireNoteForOther);

export const createCountSchema = z.object({
  warehouseId: uuidSchema,
  locationId: optionalUuidSchema,
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

export const recordCountSchema = z.object({
  countedQuantity: decimalString({ maxScale: 6, min: "0" }),
});

export const addCountLineSchema = z.object({
  productId: uuidSchema,
  lotCode: lotCodeSchema,
  expiresOn: dateSchema,
  locationId: optionalUuidSchema,
});

export const SHORTAGE_REASONS = [
  "DAMAGED_IN_TRANSIT",
  "LOST_IN_TRANSIT",
  "SHORT_SHIPPED",
  "OTHER",
] as const;

export const createShipmentSchema = z.object({
  fromWarehouseId: uuidSchema,
  toWarehouseId: uuidSchema,
  expectedOn: dateSchema,
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

export const shipmentLineSchema = z.object({
  balanceId: uuidSchema,
  quantity: quantitySchema,
  uomId: uuidSchema,
});

export const receiveShipmentSchema = z.object({
  toLocationId: optionalUuidSchema,
  lines: z
    .array(
      z
        .object({
          lineId: uuidSchema,
          /** In the line's unit; less than dispatched needs a shortage reason. */
          receivedQuantity: decimalString({ maxScale: 6, min: "0" }),
          shortageReason: z
            .string()
            .optional()
            .transform((v) => (v ? v : undefined))
            .refine((v) => v === undefined || (SHORTAGE_REASONS as readonly string[]).includes(v), {
              error: "invalidOption",
            }),
        })
        .strict(),
    )
    .min(1)
    .max(500),
  idempotencyKey: idempotencyKeySchema,
});

export const cancelShipmentSchema = z.object({ reason: requiredText(500) });
