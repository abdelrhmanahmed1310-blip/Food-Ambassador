import { z } from "zod";
import { isCountryCode } from "@/lib/countries";
import { isValidHsCode, normalizeHsCode } from "@/modules/trade/rules";
import { decimalString } from "@/lib/decimal";
import {
  codeSchema,
  idempotencyKeySchema,
  optionalText,
  optionalUuidSchema,
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
  categoryId: optionalUuidSchema,
  /** Customs tariff code (ADR-113): dots and spaces dropped; empty clears; left out = unchanged. */
  hsCode: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : normalizeHsCode(v) || null))
    .refine((v) => v == null || isValidHsCode(v), { error: "invalidHsCode" }),
  /** Country of origin, ISO 3166-1 alpha-2 (ADR-113). */
  originCountry: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.trim().toUpperCase() || null))
    .refine((v) => v == null || isCountryCode(v), { error: "invalidOption" }),
  /** Receipts go to quarantine for inspection (ADR-101). Left out = unchanged (new: no). */
  inspectOnReceipt: z
    .union([z.boolean(), z.enum(["on", "true", "false"], { error: "invalidOption" })])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "on" || v === "true")),
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

export const categorySchema = z.object({
  code: codeSchema,
  name: requiredText(120),
  nameAr: optionalText(120),
});
