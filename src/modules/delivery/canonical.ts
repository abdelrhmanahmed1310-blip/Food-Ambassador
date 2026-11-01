import { z } from "zod";
import { decimalString } from "@/lib/decimal";

/**
 * The canonical delivery order format (DECISIONS.md ADR-069,
 * docs/DELIVERY.md). Every platform adapter turns what its platform sends
 * into these events; middleware (or a platform itself) can send them as is.
 * Amounts are strings in the base currency, VAT included, as the guest paid.
 */

const id = z.string().trim().min(1).max(100);
const money = decimalString({ maxScale: 4, min: "0", max: "1000000" });

const modifier = z.object({
  externalId: id,
  name: z.string().trim().max(120).optional(),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
});

const item = z.object({
  externalId: id,
  name: z.string().trim().max(120).optional(),
  quantity: z.coerce.number().int().min(1).max(999),
  /** Per unit, with its modifiers, VAT included — what the guest paid. */
  unitPrice: money,
  modifiers: z.array(modifier).max(40).default([]),
  note: z.string().trim().max(200).optional(),
});

export const placedSchema = z.object({
  event: z.literal("order.placed"),
  order: z.object({
    id,
    /** Short code the rider shows at the counter. */
    displayCode: z.string().trim().max(40).optional(),
    placedAt: z.iso.datetime({ offset: true }),
    /** For the kitchen ticket and the counter; no phone or address is kept. */
    customerName: z.string().trim().max(80).optional(),
    note: z.string().trim().max(300).optional(),
    items: z.array(item).min(1).max(200),
    /** Discount funded by the restaurant, off the items, VAT included. */
    discount: money.default("0"),
    /** Items less the discount: what the restaurant sells (delivery fee excluded). */
    total: money,
  }),
});

export const cancelledSchema = z.object({
  event: z.literal("order.cancelled"),
  order: z.object({ id, reason: z.string().trim().max(200).optional() }),
});

export const deliveryEventSchema = z.discriminatedUnion("event", [placedSchema, cancelledSchema]);
export type DeliveryEvent = z.infer<typeof deliveryEventSchema>;
export type PlacedOrder = z.infer<typeof placedSchema>["order"];
