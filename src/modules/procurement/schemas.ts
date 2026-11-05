import { SERVICE_LEVELS, type ServiceLevel } from "@/modules/forecasting/rules";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
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
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });

/** ISO code; whether it is allowed is checked against the organization (fx/service). */
export const optionalCurrency = z
  .string()
  .optional()
  .transform((v) => blank(v)?.toUpperCase())
  .refine((v) => v === undefined || /^[A-Z]{3}$/.test(v), { error: "invalidOption" });

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
  /** Default document currency (ADR-050); empty = base currency. */
  currency: optionalCurrency,
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
  /** Percent, 0–100. */
  overReceiptTolerancePercent: z
    .string()
    .optional()
    .transform((v) => blank(v) ?? "0")
    .pipe(decimalString({ maxScale: 4, min: "0", max: "100" })),
  /** Percent, 0–100: how far an invoice price may differ from the order price (ADR-038). */
  invoicePriceTolerancePercent: z
    .string()
    .optional()
    .transform((v) => blank(v) ?? "0")
    .pipe(decimalString({ maxScale: 4, min: "0", max: "100" })),
  /** New suppliers wait for approval (ADR-091). */
  supplierApprovalRequired: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  /** Days a forecast-based order covers besides the lead time (ADR-120). */
  forecastReviewDays: z
    .string()
    .optional()
    .transform((v) => blank(v) ?? "7")
    .refine((v) => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 90, {
      error: "invalidReviewDays",
    })
    .transform(Number),
  forecastServiceLevel: z
    .string()
    .optional()
    .transform((v) => blank(v) ?? "0.95")
    .refine((v) => Object.hasOwn(SERVICE_LEVELS, v), { error: "invalidOption" })
    .transform((v) => v as ServiceLevel),
});

// ─── Supplier compliance (ADR-091) ───

export const SUPPLIER_DOCUMENT_TYPES = [
  "COMMERCIAL_REGISTRATION",
  "VAT_CERTIFICATE",
  "MUNICIPALITY_LICENSE",
  "FOOD_SAFETY_CERTIFICATE",
  "HALAL_CERTIFICATE",
  "ISO_CERTIFICATE",
  "INSURANCE",
  "CONTRACT",
  "OTHER",
] as const;

const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");

export const supplierDocumentSchema = z
  .object({
    type: z.enum(SUPPLIER_DOCUMENT_TYPES, { error: "invalidOption" }),
    title: optionalText(160),
    number: optionalText(80),
    issuedOn: dateSchema,
    expiresOn: dateSchema,
    requiredToBuy: checkbox,
    note: optionalText(1000),
  })
  .refine((v) => v.type !== "OTHER" || v.title !== undefined, {
    error: "required",
    path: ["title"],
  })
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, {
    error: "expiryBeforeIssue",
    path: ["expiresOn"],
  })
  .refine((v) => !v.requiredToBuy || v.expiresOn !== undefined, {
    error: "requiredDocumentNeedsExpiry",
    path: ["expiresOn"],
  });

export const blockSupplierSchema = z.object({ reason: requiredText(500) });

export const supplierBankAccountSchema = z.object({
  bankName: requiredText(120),
  accountName: requiredText(160),
  kind: z.enum(["IBAN", "ACCOUNT_NUMBER"], { error: "invalidOption" }),
  account: requiredText(64),
  swiftBic: optionalText(16),
  currency: optionalCurrency,
});

export const orderHeaderSchema = z.object({
  supplierId: uuidSchema,
  warehouseId: uuidSchema,
  /** Empty = the supplier's currency (ADR-050). */
  currency: optionalCurrency,
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
  /** Currency of the amount (ADR-053); empty = base currency. */
  currency: optionalCurrency,
  reference: optionalText(100),
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

export const createRequisitionSchema = z.object({
  warehouseId: uuidSchema,
  neededBy: dateSchema,
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

export const requisitionLineSchema = z.object({
  productId: uuidSchema,
  quantity: decimalString({ maxScale: 6, min: "0.000001" }),
  uomId: uuidSchema,
  note: optionalText(200),
});

/** Turn selected open lines into one draft order; each selected line needs a price. */
export const orderRequisitionSchema = z.object({
  supplierId: uuidSchema,
  expectedOn: dateSchema,
  lines: z
    .array(
      z
        .object({
          lineId: uuidSchema,
          include: z
            .string()
            .optional()
            .transform((v) => v === "on" || v === "true"),
          unitPrice: optionalDecimal({ maxScale: 6, min: "0" }),
        })
        .strict(),
    )
    .max(500)
    .superRefine((lines, ctx) => {
      lines.forEach((l, i) => {
        if (l.include && l.unitPrice === undefined)
          ctx.addIssue({ code: "custom", path: [i, "unitPrice"], message: "required" });
      });
      if (!lines.some((l) => l.include))
        ctx.addIssue({ code: "custom", path: [], message: "nothingSelected" });
    }),
  idempotencyKey: idempotencyKeySchema,
});

// ─── Requests for quotation (ADR-092) ───

export const rfqHeaderSchema = z
  .object({
    title: requiredText(160),
    neededBy: dateSchema,
    respondBy: dateSchema,
    note: optionalText(1000),
  })
  .refine((v) => !v.neededBy || !v.respondBy || v.respondBy <= v.neededBy, {
    error: "respondAfterNeeded",
    path: ["respondBy"],
  });

export const createRfqSchema = z
  .object({
    warehouseId: uuidSchema,
    title: requiredText(160),
    neededBy: dateSchema,
    respondBy: dateSchema,
    note: optionalText(1000),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine((v) => !v.neededBy || !v.respondBy || v.respondBy <= v.neededBy, {
    error: "respondAfterNeeded",
    path: ["respondBy"],
  });

export const rfqSupplierSchema = z.object({ supplierId: uuidSchema });

export const quotationSchema = z.object({
  supplierId: uuidSchema,
  /** Empty = the supplier's currency, else the company's. */
  currency: optionalCurrency,
  reference: optionalText(80),
  quotedOn: z
    .string()
    .transform((v) => v.trim())
    .refine(isCalendarDate, { error: "invalidDate" }),
  validUntil: dateSchema,
  leadTimeDays: optionalDays,
  note: optionalText(1000),
  lines: z
    .array(
      z
        .object({
          rfqLineId: uuidSchema,
          /** Empty = not quoted. */
          unitPrice: optionalDecimal({ maxScale: 6, min: "0" }),
          /** Empty = all of the requested quantity. */
          quantity: optionalDecimal({ maxScale: 6, min: "0.000001" }),
          note: optionalText(200),
        })
        .strict(),
    )
    .max(500),
});

export const awardRfqSchema = z.object({
  expectedOn: dateSchema,
  lines: z
    .array(
      z
        .object({
          rfqLineId: uuidSchema,
          /** Empty = not awarded. */
          quotationLineId: optionalUuidSchema,
          reason: optionalText(500),
        })
        .strict(),
    )
    .max(500),
  idempotencyKey: idempotencyKeySchema,
});
