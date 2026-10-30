import { z } from "zod";
import { decimalString, toDecimal } from "@/lib/decimal";
import {
  codeSchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const optionalCelsius = z
  .string()
  .optional()
  .transform(blank)
  .pipe(decimalString({ maxScale: 1, min: "-100", max: "300", allowNegative: true }).optional());
const optionalNumber = z
  .string()
  .optional()
  .transform(blank)
  .pipe(
    decimalString({ maxScale: 3, min: "-1000000", max: "1000000", allowNegative: true }).optional(),
  );
const dateSchema = z
  .string()
  .optional()
  .transform(blank)
  .refine(
    (v) =>
      v === undefined ||
      (/^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)),
    { error: "invalidDate" },
  );

export const CHECKPOINT_KINDS = [
  "FRIDGE",
  "FREEZER",
  "HOT_HOLDING",
  "COOKING",
  "AMBIENT",
  "OTHER",
] as const;
export const RECORD_TYPES = [
  "TEMPERATURE",
  "HYGIENE",
  "CLEANING",
  "PEST_CONTROL",
  "OTHER",
] as const;
export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const limitsRefine = (v: { minCelsius?: string; maxCelsius?: string }, ctx: z.RefinementCtx) => {
  if (v.minCelsius === undefined && v.maxCelsius === undefined)
    ctx.addIssue({ code: "custom", path: ["maxCelsius"], message: "limitRequired" });
  if (
    v.minCelsius !== undefined &&
    v.maxCelsius !== undefined &&
    toDecimal(v.minCelsius).gt(toDecimal(v.maxCelsius))
  )
    ctx.addIssue({ code: "custom", path: ["maxCelsius"], message: "maxBelowMin" });
};

export const checkpointSchema = z
  .object({
    branchId: uuidSchema,
    code: codeSchema,
    name: requiredText(120),
    kind: z.enum(CHECKPOINT_KINDS, { error: "invalidOption" }),
    minCelsius: optionalCelsius,
    maxCelsius: optionalCelsius,
  })
  .superRefine(limitsRefine);

export const recordSchema = z
  .object({
    type: z.enum(RECORD_TYPES, { error: "invalidOption" }),
    /** Temperature readings: the checkpoint gives the branch and limits. */
    checkpointId: optionalUuidSchema,
    /** Other checks: the branch they were done in. */
    branchId: optionalUuidSchema,
    valueCelsius: optionalCelsius,
    passed: z.enum(["yes", "no"], { error: "invalidOption" }).optional(),
    note: optionalText(500),
    correctiveNote: optionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (v.type === "TEMPERATURE") {
      if (!v.checkpointId)
        ctx.addIssue({ code: "custom", path: ["checkpointId"], message: "required" });
      if (v.valueCelsius === undefined)
        ctx.addIssue({ code: "custom", path: ["valueCelsius"], message: "required" });
    } else {
      if (!v.branchId) ctx.addIssue({ code: "custom", path: ["branchId"], message: "required" });
      if (!v.passed) ctx.addIssue({ code: "custom", path: ["passed"], message: "required" });
    }
  });

export const templateSchema = z.object({ name: requiredText(120), description: optionalText(500) });

export const checklistItemSchema = z
  .object({
    text: requiredText(300),
    kind: z.enum(["YES_NO", "NUMBER"], { error: "invalidOption" }),
    minValue: optionalNumber,
    maxValue: optionalNumber,
  })
  .superRefine((v, ctx) => {
    if (v.kind === "YES_NO" && (v.minValue !== undefined || v.maxValue !== undefined))
      ctx.addIssue({ code: "custom", path: ["minValue"], message: "notForYesNo" });
    if (
      v.minValue !== undefined &&
      v.maxValue !== undefined &&
      toDecimal(v.minValue).gt(toDecimal(v.maxValue))
    )
      ctx.addIssue({ code: "custom", path: ["maxValue"], message: "maxBelowMin" });
  });

export const runSchema = z.object({
  branchId: uuidSchema,
  note: optionalText(1000),
  answers: z
    .array(
      z
        .object({
          itemId: uuidSchema,
          yes: z.enum(["yes", "no"], { error: "required" }).optional(),
          value: optionalNumber,
          note: optionalText(500),
        })
        .strict(),
    )
    .max(200),
});

export const nonConformanceSchema = z.object({
  branchId: uuidSchema,
  title: requiredText(160),
  description: requiredText(2000),
  severity: z.enum(SEVERITIES, { error: "invalidOption" }),
});

export const investigateSchema = z.object({ rootCause: requiredText(2000) });

export const actionSchema = z.object({
  description: requiredText(1000),
  ownerUserId: optionalUuidSchema,
  dueOn: dateSchema,
});

export const noteSchema = z.object({ note: requiredText(1000) });
