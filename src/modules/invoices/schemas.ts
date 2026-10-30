import { z } from "zod";
import { decimalString } from "@/lib/decimal";
import { isCalendarDate } from "@/lib/dates";
import {
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const date = z
  .string({ error: "required" })
  .trim()
  .refine(isCalendarDate, { error: "invalidDate" });
const optionalDate = z
  .string()
  .optional()
  .transform(blank)
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });

export const invoiceSchema = z.object({
  supplierId: uuidSchema,
  supplierInvoiceNo: requiredText(60),
  invoiceDate: date,
  dueDate: optionalDate,
  printedGross: decimalString({ maxScale: 4, min: "0" }),
  note: optionalText(500),
  idempotencyKey: z.string().optional(),
});

export const invoiceHeaderSchema = invoiceSchema.omit({ supplierId: true, idempotencyKey: true });

export const goodsLineSchema = z.object({
  receiptLineId: uuidSchema,
  quantity: decimalString({ maxScale: 6, min: "0.000001" }),
  unitPrice: decimalString({ maxScale: 6, min: "0" }),
  taxCodeId: optionalUuidSchema,
});

export const chargeLineSchema = z.object({
  description: requiredText(200),
  netAmount: decimalString({ maxScale: 4, min: "0.0001" }),
  taxCodeId: optionalUuidSchema,
});

export const noteSchema = z.object({ note: requiredText(1000) });
export const reasonSchema = z.object({ reason: requiredText(500) });
