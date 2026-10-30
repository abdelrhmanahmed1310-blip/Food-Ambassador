import { z } from "zod";
import { decimalString, toDecimal, type Decimal } from "@/lib/decimal";
import {
  codeSchema,
  idempotencyKeySchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

const optionalDays = z
  .string()
  .optional()
  .transform(blank)
  .refine((v) => v === undefined || /^\d{1,4}$/.test(v), { error: "invalidDays" })
  .transform((v) => (v === undefined ? undefined : Number(v)))
  .refine((v) => v === undefined || v <= 3650, { error: "invalidDays" });

const optionalEmail = z
  .string()
  .optional()
  .transform(blank)
  .refine((v) => v === undefined || z.email().safeParse(v).success, { error: "invalidEmail" });

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

const optionalDecimal = (opts: {
  maxScale: number;
  min?: string;
  max?: string;
  allowNegative?: boolean;
}) => z.string().optional().transform(blank).pipe(decimalString(opts).optional());

export const supplierSchema = z.object({
  code: codeSchema,
  name: requiredText(160),
  nameAr: optionalText(160),
  taxId: optionalText(40),
  contactName: optionalText(120),
  email: optionalEmail,
  phone: optionalText(40),
  address: optionalText(300),
  paymentTermsDays: optionalDays,
  leadTimeDays: optionalDays,
  note: optionalText(1000),
});
export const createSupplierSchema = supplierSchema.extend({ idempotencyKey: idempotencyKeySchema });

export const supplierProductSchema = z.object({
  productId: uuidSchema,
  purchaseUomId: uuidSchema,
  supplierSku: optionalText(60),
  lastUnitPrice: optionalDecimal({ maxScale: 6, min: "0" }),
  leadTimeDays: optionalDays,
  minOrderQuantity: optionalDecimal({ maxScale: 6, min: "0.000001" }),
  preferred: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

export const settingsSchema = z.object({
  /** Empty = no approval step. */
  approvalThreshold: optionalDecimal({ maxScale: 4, min: "0" }),
  /** Percent, 0–100. */
  overReceiptTolerancePercent: z
    .string()
    .optional()
    .transform((v) => blank(v) ?? "0")
    .pipe(decimalString({ maxScale: 4, min: "0", max: "100" })),
});

export const orderHeaderSchema = z.object({
  supplierId: uuidSchema,
  warehouseId: uuidSchema,
  expectedOn: dateSchema,
  note: optionalText(1000),
});
export const createOrderSchema = orderHeaderSchema.extend({ idempotencyKey: idempotencyKeySchema });

export const orderLineSchema = z.object({
  productId: uuidSchema,
  uomId: uuidSchema,
  quantity: decimalString({ maxScale: 6, min: "0.000001" }),
  unitPrice: decimalString({ maxScale: 6, min: "0" }),
  note: optionalText(300),
});

export const reasonSchema = z.object({ reason: requiredText(500) });
export const optionalNoteSchema = z.object({ note: optionalText(500) });

export const REJECTION_REASONS = [
  "DAMAGED",
  "WRONG_ITEM",
  "QUALITY",
  "TEMPERATURE",
  "EXPIRED",
  "SHORT_SHELF_LIFE",
  "OTHER",
] as const;

const receiptLineSchema = z
  .object({
    purchaseOrderLineId: uuidSchema,
    /** Empty or 0 = this line was not delivered. */
    receivedQuantity: z
      .string()
      .optional()
      .transform((v) => blank(v) ?? "0")
      .pipe(decimalString({ maxScale: 6, min: "0" })),
    rejectedQuantity: z
      .string()
      .optional()
      .transform((v) => blank(v) ?? "0")
      .pipe(decimalString({ maxScale: 6, min: "0" })),
    rejectionReason: z
      .string()
      .optional()
      .transform(blank)
      .refine((v) => v === undefined || (REJECTION_REASONS as readonly string[]).includes(v), {
        error: "invalidOption",
      }),
    unitPrice: decimalString({ maxScale: 6, min: "0" }),
    lotCode: z
      .string()
      .optional()
      .transform((v) => blank(v)?.toUpperCase())
      .refine((v) => v === undefined || /^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(v), {
        error: "invalidLotCode",
      }),
    expiresOn: dateSchema,
    quarantine: z
      .string()
      .optional()
      .transform((v) => v === "on" || v === "true"),
    temperatureCelsius: optionalDecimal({
      maxScale: 1,
      min: "-80",
      max: "80",
      allowNegative: true,
    }),
  })
  .superRefine((l, ctx) => {
    // Runs even when a field failed; only compare values that parsed.
    let received: Decimal, rejected: Decimal;
    try {
      received = toDecimal(l.receivedQuantity);
      rejected = toDecimal(l.rejectedQuantity);
    } catch {
      return;
    }
    if (rejected.greaterThan(received))
      ctx.addIssue({
        code: "custom",
        path: ["rejectedQuantity"],
        message: "rejectedExceedsReceived",
      });
    if (rejected.gt(0) && !l.rejectionReason)
      ctx.addIssue({ code: "custom", path: ["rejectionReason"], message: "required" });
  });

export const receiptSchema = z.object({
  locationId: optionalUuidSchema,
  deliveryNoteRef: optionalText(60),
  note: optionalText(500),
  lines: z.array(receiptLineSchema).min(1, { error: "required" }).max(500),
  idempotencyKey: idempotencyKeySchema,
});
export type ReceiptInput = z.input<typeof receiptSchema>;

export const reorderRuleSchema = z.object({
  warehouseId: uuidSchema,
  productId: uuidSchema,
  uomId: uuidSchema,
  minQuantity: decimalString({ maxScale: 6, min: "0" }),
  maxQuantity: decimalString({ maxScale: 6, min: "0.000001" }),
});

export const LANDED_COST_CHARGES = [
  "FREIGHT",
  "CUSTOMS_DUTY",
  "INSURANCE",
  "HANDLING",
  "OTHER",
] as const;
export const LANDED_COST_METHODS = ["BY_VALUE", "BY_QUANTITY"] as const;

export const landedCostSchema = z.object({
  chargeType: z.enum(LANDED_COST_CHARGES, { error: "invalidOption" }),
  method: z.enum(LANDED_COST_METHODS, { error: "invalidOption" }),
  amount: decimalString({ maxScale: 4, min: "0.0001" }),
  reference: optionalText(100),
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});
