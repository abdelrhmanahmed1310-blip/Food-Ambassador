import { z } from "zod";
import { decimalString } from "@/lib/decimal";
import {
  idempotencyKeySchema,
  optionalText,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import { SYMBOLOGIES } from "./barcodes";
import { DIMENSIONS } from "./units";

export const PRODUCT_TYPES = [
  "RAW_MATERIAL",
  "SEMI_FINISHED",
  "FINISHED_GOOD",
  "PACKAGING",
  "CONSUMABLE",
] as const;
export const LOT_TRACKING = ["NONE", "LOT", "LOT_AND_EXPIRY"] as const;
export const STORAGE_ZONES = ["AMBIENT", "CHILLED", "FROZEN"] as const;

/** SKUs: upper-case letters, digits, '-', '_' and '.', up to 40 characters. */
export const skuSchema = z
  .string({ error: "required" })
  .trim()
  .toUpperCase()
  .min(1, { error: "required" })
  .max(40, { error: "tooLong" })
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/, { error: "invalidSku" });

const optionalPositiveInt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || /^[1-9]\d{0,4}$/.test(v), { error: "invalidPositiveInteger" })
  .transform((v) => (v === undefined ? undefined : Number(v)));

export const productSchema = z.object({
  sku: skuSchema,
  nameEn: requiredText(160),
  nameAr: optionalText(160),
  type: z.enum(PRODUCT_TYPES, { error: "invalidOption" }),
  baseUomId: uuidSchema,
  lotTracking: z.enum(LOT_TRACKING, { error: "invalidOption" }).default("NONE"),
  shelfLifeDays: optionalPositiveInt,
  storageRequirement: z.enum(STORAGE_ZONES, { error: "invalidOption" }).default("AMBIENT"),
});
export const createProductSchema = productSchema.extend({ idempotencyKey: idempotencyKeySchema });
export type ProductInput = z.input<typeof productSchema>;

export const unitSchema = z.object({
  code: z
    .string({ error: "required" })
    .trim()
    .toLowerCase()
    .min(1, { error: "required" })
    .max(20, { error: "tooLong" })
    .regex(/^[a-z0-9][a-z0-9_-]*$/, { error: "invalidUnitCode" }),
  nameEn: requiredText(60),
  nameAr: requiredText(60),
  dimension: z.enum(DIMENSIONS, { error: "invalidOption" }),
  /** Empty = packaging unit (converted only per product). */
  factorToBase: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(decimalString({ maxScale: 12, min: "0.000000000001" }).optional()),
});

export const conversionSchema = z.object({
  uomId: uuidSchema,
  factorToBase: decimalString({ maxScale: 12, min: "0.000000000001" }),
});

export const barcodeSchema = z.object({
  barcode: z
    .string({ error: "required" })
    .trim()
    .min(1, { error: "required" })
    .max(64, { error: "tooLong" }),
  symbology: z.enum(SYMBOLOGIES, { error: "invalidOption" }),
  uomId: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(uuidSchema.optional()),
});
