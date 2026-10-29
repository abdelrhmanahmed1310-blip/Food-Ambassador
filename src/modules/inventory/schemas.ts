import { z } from "zod";
import { decimalString } from "@/lib/decimal";
import {
  idempotencyKeySchema,
  optionalText,
  optionalUuidSchema,
  uuidSchema,
} from "@/modules/shared/schemas";
import { STOCK_STATUSES } from "./rules";

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
  .refine(
    (v) =>
      v === undefined ||
      (/^\d{4}-\d{2}-\d{2}$/.test(v) &&
        !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
        new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)),
    {
      error: "invalidDate",
    },
  );

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
const statusSchema = z.enum(STOCK_STATUSES, { error: "invalidOption" });

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
