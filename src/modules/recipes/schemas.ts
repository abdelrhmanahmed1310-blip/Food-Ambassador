import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { decimalString, toDecimal } from "@/lib/decimal";
import {
  codeSchema,
  idempotencyKeySchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import { COST_POLICIES } from "./costing";

export const RECIPE_TYPES = ["DISH", "PREPARATION"] as const;

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const optionalDecimal = (opts: { maxScale: number; min?: string }) =>
  z.string().optional().transform(blank).pipe(decimalString(opts).optional());

const yieldFields = {
  yieldQuantity: decimalString({ maxScale: 6, min: "0.000001" }),
  yieldUomId: uuidSchema,
  portions: optionalDecimal({ maxScale: 6, min: "0.000001" }),
  note: optionalText(500),
};

export const recipeSchema = z.object({
  name: requiredText(120),
  nameAr: optionalText(120),
  description: optionalText(1000),
});

export const createRecipeSchema = recipeSchema
  .extend({
    code: codeSchema,
    type: z.enum(RECIPE_TYPES, { error: "invalidOption" }),
    ...yieldFields,
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((v, ctx) => {
    if (v.type === "DISH" && v.portions === undefined)
      ctx.addIssue({ code: "custom", path: ["portions"], message: "required" });
  });

export const versionSchema = z.object({ ...yieldFields, method: optionalText(5000) });

/** `item` is "product:<id>" or "recipe:<id>"; waste is entered in percent (0 ≤ w < 100). */
export const ingredientSchema = z
  .object({
    item: z
      .string({ error: "required" })
      .regex(/^(product|recipe):[0-9a-f-]{36}$/i, { error: "invalidOption" }),
    quantity: decimalString({ maxScale: 6, min: "0.000001" }),
    uomId: uuidSchema,
    wastePercent: optionalDecimal({ maxScale: 4, min: "0" }),
    note: optionalText(200),
  })
  .superRefine((v, ctx) => {
    if (v.wastePercent !== undefined && !toDecimal(v.wastePercent).lt(100))
      ctx.addIssue({ code: "custom", path: ["wastePercent"], message: "aboveMaximum" });
  })
  .transform(({ item, wastePercent, ...rest }) => {
    const [kind, id] = item.split(":");
    return {
      ...rest,
      productId: kind === "product" ? id.toLowerCase() : null,
      subRecipeId: kind === "recipe" ? id.toLowerCase() : null,
      wasteFraction: toDecimal(wastePercent ?? "0")
        .dividedBy(100)
        .toFixed(),
    };
  });

export const costQuerySchema = z.object({
  policy: z.enum(COST_POLICIES, { error: "invalidOption" }).catch("AVERAGE"),
  warehouseId: optionalUuidSchema.catch(undefined),
});

export const standardCostSchema = z.object({
  unitCost: decimalString({ maxScale: 6, min: "0" }),
  effectiveFrom: z
    .string({ error: "required" })
    .trim()
    .refine((v) => isCalendarDate(v), { error: "invalidDate" }),
  note: optionalText(200),
  idempotencyKey: idempotencyKeySchema,
});

const percent = (v: string) => toDecimal(v).dividedBy(100).toFixed();
/** Target food cost in percent (0 < p < 100); blank clears it. */
const targetPercent = z
  .string()
  .optional()
  .transform(blank)
  .pipe(decimalString({ maxScale: 2, min: "0.01", max: "99.99" }).optional())
  .transform((v) => (v === undefined ? null : percent(v)));

export const targetSchema = z.object({ targetPercent });

export const recipePriceSchema = z.object({
  price: decimalString({ maxScale: 4, min: "0.0001" }),
  effectiveFrom: z
    .string({ error: "required" })
    .trim()
    .refine((v) => isCalendarDate(v), { error: "invalidDate" }),
  note: optionalText(200),
  idempotencyKey: idempotencyKeySchema,
});

export const simulationSchema = z.object({
  productId: uuidSchema,
  unitCost: decimalString({ maxScale: 6, min: "0" }),
});

export const bulkReplaceSchema = z.object({
  fromProductId: uuidSchema,
  toProductId: uuidSchema,
  /** New quantity = old quantity × factor, in the same unit. */
  factor: decimalString({ maxScale: 6, min: "0.000001" }),
  activate: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});
