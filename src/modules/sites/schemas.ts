import { z } from "zod";
import {
  codeSchema,
  idempotencyKeySchema,
  optionalText,
  optionalTimeZoneSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";

export const BRANCH_TYPES = [
  "RESTAURANT",
  "CENTRAL_KITCHEN",
  "WAREHOUSE_SITE",
  "OFFICE",
  "OTHER",
] as const;
export const WAREHOUSE_TYPES = ["MAIN", "KITCHEN_STORE", "BAR", "TRANSIT", "OTHER"] as const;
export const TEMPERATURE_ZONES = ["AMBIENT", "CHILLED", "FROZEN"] as const;

const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || /^[A-Z]{2}$/.test(v), { error: "invalidCountry" });

export const branchSchema = z.object({
  code: codeSchema,
  name: requiredText(120),
  type: z.enum(BRANCH_TYPES, { error: "invalidOption" }),
  timeZone: optionalTimeZoneSchema,
  addressLine: optionalText(200),
  city: optionalText(100),
  country: countrySchema,
});
export const createBranchSchema = branchSchema.extend({ idempotencyKey: idempotencyKeySchema });
export type BranchInput = z.input<typeof branchSchema>;

export const warehouseSchema = z.object({
  branchId: uuidSchema,
  code: codeSchema,
  name: requiredText(120),
  type: z.enum(WAREHOUSE_TYPES, { error: "invalidOption" }),
});
export const createWarehouseSchema = warehouseSchema.extend({
  idempotencyKey: idempotencyKeySchema,
});
/** A warehouse cannot move between branches once created (stock history belongs to its site). */
export const updateWarehouseSchema = warehouseSchema.omit({ branchId: true });
export type WarehouseInput = z.input<typeof warehouseSchema>;

export const locationSchema = z.object({
  code: codeSchema,
  name: requiredText(120),
  temperatureZone: z.enum(TEMPERATURE_ZONES, { error: "invalidOption" }),
});
export const createLocationSchema = locationSchema.extend({ idempotencyKey: idempotencyKeySchema });

export const listStatusSchema = z.enum(["active", "archived", "all"]).catch("active");
export type ListStatus = z.infer<typeof listStatusSchema>;
