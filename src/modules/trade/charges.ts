import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString, toDecimal } from "@/lib/decimal";
import { isUuid, uuidv7 } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { assertDocumentCurrency, baseAmount, companyContext, rateFor } from "@/modules/fx/service";
import { postLandedCost } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { allocateCharge } from "@/modules/procurement/rules";
import { optionalCurrency } from "@/modules/procurement/schemas";
import { idempotencyKeySchema, optionalText, requiredText } from "@/modules/shared/schemas";
import { runIdempotent } from "@/modules/shared/idempotency";
import { currencyDecimals } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";

/**
 * Customs entries and shipment charges (DECISIONS.md ADR-115). A customs
 * entry records the declaration as customs assessed it — no duty rate is
 * assumed. A charge (freight, duty, insurance, handling, other) is spread
 * over every line of the shipment's linked receipts — by value in the
 * company's currency, or by quantity — and posted per receipt as landed
 * costs (ADR-028) through the inventory module. Both are append-only.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const TAKES_CHARGES = ["ARRIVED", "CLEARED", "CLOSED"] as const;
const CHARGES = ["FREIGHT", "CUSTOMS_DUTY", "INSURANCE", "HANDLING", "OTHER"] as const;

const optionalMoney = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .pipe(decimalString({ maxScale: 4, min: "0" }).optional());

const customsSchema = z.object({
  number: requiredText(60),
  declaredOn: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  broker: optionalText(160),
  customsValue: optionalMoney,
  dutyAmount: optionalMoney,
  importVat: optionalMoney,
  note: optionalText(500),
});

const chargeSchema = z.object({
  chargeType: z.enum(CHARGES, { error: "invalidOption" }),
  method: z.enum(["BY_VALUE", "BY_QUANTITY"], { error: "invalidOption" }),
  amount: decimalString({ maxScale: 4, min: "0.0001" }),
  currency: optionalCurrency,
  customsEntryId: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .refine((v) => v === undefined || isUuid(v), { error: "invalidOption" }),
  reference: optionalText(100),
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

async function loadShipment(tx: Tx, ctx: TenantContext, shipmentId: string) {
  if (!isUuid(shipmentId)) throw notFound("Shipment");
  const s = await tx.importShipment.findFirst({
    where: { organizationId: ctx.organizationId, id: shipmentId },
    select: {
      id: true,
      number: true,
      status: true,
      warehouseId: true,
      warehouse: { select: { branchId: true, branch: { select: { timeZone: true } } } },
    },
  });
  const where = s ? { warehouseId: s.warehouseId, branchId: s.warehouse.branchId } : undefined;
  if (!s || !hasPermission(ctx.grants, "trade.view", where)) throw notFound("Shipment");
  return { ...s, where: where! };
}

function assertFits(currency: string, amount: string | undefined, field: string) {
  if (amount && toDecimal(amount).decimalPlaces() > currencyDecimals(currency))
    throw businessRuleViolation("AMOUNT_TOO_PRECISE", "More decimals than the currency has", {
      field,
      decimals: currencyDecimals(currency),
    });
}

/** The declaration as customs assessed it, in the company's currency; after arrival. */
export async function recordCustomsEntry(
  ctx: TenantContext,
  shipmentId: string,
  rawInput: unknown,
) {
  const parsed = customsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const s = await loadShipment(tx, ctx, shipmentId);
      if (!hasPermission(ctx.grants, "trade.manage", s.where)) throw forbidden();
      if (!(TAKES_CHARGES as readonly string[]).includes(s.status))
        throw businessRuleViolation("SHIPMENT_NOT_ARRIVED", "Customs entries follow arrival");
      const today = businessDate(s.warehouse.branch.timeZone ?? ctx.timeZone);
      if (input.declaredOn > today)
        throw businessRuleViolation("DATE_IN_FUTURE", "The date is in the future", {
          field: "declaredOn",
        });
      const company = await companyContext(tx, ctx, { warehouseId: s.warehouseId });
      const currency = company.currency;
      assertFits(currency, input.customsValue, "customsValue");
      assertFits(currency, input.dutyAmount, "dutyAmount");
      assertFits(currency, input.importVat, "importVat");
      const e = await tx.importCustomsEntry.create({
        data: {
          organizationId: ctx.organizationId,
          shipmentId: s.id,
          number: input.number,
          declaredOn: new Date(`${input.declaredOn}T00:00:00Z`),
          broker: input.broker ?? null,
          currency,
          customsValue: input.customsValue ?? null,
          dutyAmount: input.dutyAmount ?? "0",
          importVat: input.importVat ?? "0",
          note: input.note ?? null,
          createdByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "import_shipment.customs_entry",
        entityType: "import_shipment",
        entityId: s.id,
        changes: { ...input, currency },
      });
      return e;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Declaration already recorded", {
        reason: "declarationTaken",
        field: "number",
      });
    throw error;
  }
}

/**
 * Spread a charge over the shipment's receipts and post it as landed costs.
 * Needs `inventory.valuation.revalue` at the warehouse, as any landed cost.
 */
export async function postShipmentCharge(
  ctx: TenantContext,
  shipmentId: string,
  rawInput: unknown,
) {
  const parsed = chargeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "trade.shipment_charge", input: { shipmentId, ...input } },
    async (tx) => {
      const s = await loadShipment(tx, ctx, shipmentId);
      if (!hasPermission(ctx.grants, "inventory.valuation.revalue", s.where)) throw forbidden();
      if (!(TAKES_CHARGES as readonly string[]).includes(s.status))
        throw businessRuleViolation("SHIPMENT_NOT_ARRIVED", "Charges follow arrival");
      if (input.customsEntryId) {
        const entry = await tx.importCustomsEntry.findFirst({
          where: { organizationId: ctx.organizationId, id: input.customsEntryId, shipmentId: s.id },
          select: { id: true },
        });
        if (!entry) throw notFound("CustomsEntry");
      }
      const receipts = await tx.goodsReceipt.findMany({
        where: { organizationId: ctx.organizationId, importShipmentId: s.id, status: "POSTED" },
        orderBy: { id: "asc" },
        select: {
          id: true,
          purchaseOrderId: true,
          warehouseId: true,
          exchangeRate: true,
          lines: {
            orderBy: { id: "asc" },
            select: {
              id: true,
              productId: true,
              acceptedQuantity: true,
              acceptedQuantityBase: true,
              unitPrice: true,
              product: { select: { baseUomId: true } },
            },
          },
        },
      });
      if (receipts.length === 0)
        throw businessRuleViolation(
          "SHIPMENT_HAS_NO_RECEIPTS",
          "Link the receipts that took the goods in first",
        );
      // Same order as receipts and their reversal: lock the orders, in id order.
      for (const orderId of [...new Set(receipts.map((r) => r.purchaseOrderId))].sort())
        await tx.$queryRaw`
          SELECT "id" FROM "purchase_orders"
          WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${orderId}::uuid FOR UPDATE`;
      const lines = receipts.flatMap((r) =>
        r.lines.filter((l) => dec(l.acceptedQuantityBase).gt(0)).map((l) => ({ ...l, receipt: r })),
      );
      if (lines.length === 0)
        throw businessRuleViolation("LANDED_COST_NO_BASIS", "Nothing was put into stock", {
          field: "method",
        });
      if (input.method === "BY_QUANTITY" && new Set(lines.map((l) => l.product.baseUomId)).size > 1)
        throw businessRuleViolation(
          "LANDED_COST_MIXED_UNITS",
          "Lines are in different units; allocate by value",
          {
            field: "method",
          },
        );
      // By value in the company's currency: each receipt's prices × its rate.
      const weights = lines.map((l) =>
        input.method === "BY_VALUE"
          ? dec(l.acceptedQuantity).times(dec(l.unitPrice)).times(dec(l.receipt.exchangeRate))
          : dec(l.acceptedQuantityBase),
      );
      if (!weights.some((w) => w.gt(0)))
        throw businessRuleViolation(
          "LANDED_COST_NO_BASIS",
          "The received goods have no value; allocate by quantity",
          {
            field: "method",
          },
        );
      const today = businessDate(s.warehouse.branch.timeZone ?? ctx.timeZone);
      const company = await companyContext(tx, ctx, { warehouseId: s.warehouseId });
      const currency = input.currency ?? company.currency;
      assertDocumentCurrency(company.ctx, currency);
      assertFits(currency, input.amount, "amount");
      const entered = toDecimal(input.amount);
      const fx = await rateFor(tx, company.ctx, currency, today);
      const amount = baseAmount(company.ctx, entered, fx.rate);
      const shares = allocateCharge(amount, weights);

      const chargeId = uuidv7();
      let capitalized = new Decimal(0);
      const documents: string[] = [];
      for (const r of receipts) {
        const mine = lines
          .map((l, i) => ({ l, share: shares[i] }))
          .filter((x) => x.l.receipt.id === r.id && x.share.gt(0));
        if (mine.length === 0) continue;
        const subtotal = mine.reduce((a, x) => a.plus(x.share), new Decimal(0));
        const posted = await postLandedCost(
          tx,
          ctx,
          {
            warehouseId: r.warehouseId,
            receiptId: r.id,
            chargeType: input.chargeType,
            method: input.method,
            amount: subtotal,
            entered: {
              currency: company.currency,
              amount: subtotal,
              rate: new Decimal(1),
              rateDate: today,
            },
            reference: input.reference ?? s.number,
            note: input.note,
            shipmentChargeId: chargeId,
            lines: mine.map((x) => ({
              receiptLineId: x.l.id,
              productId: x.l.productId,
              receivedBase: dec(x.l.acceptedQuantityBase),
              allocated: x.share,
            })),
          },
          { year: Number(today.slice(0, 4)) },
        );
        capitalized = capitalized.plus(posted.capitalized);
        documents.push(posted.number);
      }
      await tx.importShipmentCharge.create({
        data: {
          id: chargeId,
          organizationId: ctx.organizationId,
          shipmentId: s.id,
          customsEntryId: input.customsEntryId ?? null,
          chargeType: input.chargeType,
          method: input.method,
          currency,
          enteredAmount: entered.toFixed(),
          exchangeRate: fx.rate.toFixed(),
          rateDate: new Date(`${fx.rateDate}T00:00:00Z`),
          amount: amount.toFixed(),
          capitalizedAmount: capitalized.toFixed(),
          expensedAmount: amount.minus(capitalized).toFixed(),
          reference: input.reference ?? null,
          note: input.note ?? null,
          postedByUserId: ctx.userId,
        },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "import_shipment.charge_posted",
        entityType: "import_shipment",
        entityId: s.id,
        changes: { ...input, amount: amount.toFixed(), documents },
      });
      return {
        chargeId,
        amount: amount.toFixed(),
        capitalized: capitalized.toFixed(),
        expensed: amount.minus(capitalized).toFixed(),
        documents,
      };
    },
  );
}

/**
 * What the goods cost landed: their value received (company currency),
 * the charges posted by type, and the share charges add on top; customs
 * entries with the duty assessed against the duty posted.
 */
export async function shipmentCostsInTx(
  tx: Tx,
  ctx: TenantContext,
  shipmentId: string,
  warehouseId: string,
) {
  const [receipts, charges, entries, company] = await Promise.all([
    tx.goodsReceipt.findMany({
      where: { organizationId: ctx.organizationId, importShipmentId: shipmentId, status: "POSTED" },
      select: {
        exchangeRate: true,
        lines: { select: { acceptedQuantity: true, unitPrice: true } },
      },
    }),
    tx.importShipmentCharge.findMany({
      where: { organizationId: ctx.organizationId, shipmentId },
      orderBy: { postedAt: "asc" },
      include: { landedCosts: { select: { document: { select: { number: true } } } } },
    }),
    tx.importCustomsEntry.findMany({
      where: { organizationId: ctx.organizationId, shipmentId },
      orderBy: { declaredOn: "asc" },
      include: { charges: { select: { amount: true } } },
    }),
    companyContext(tx, ctx, { warehouseId }),
  ]);
  const goods = receipts
    .reduce(
      (a, r) =>
        a.plus(
          r.lines
            .reduce(
              (b, l) => b.plus(dec(l.acceptedQuantity).times(dec(l.unitPrice))),
              new Decimal(0),
            )
            .times(dec(r.exchangeRate)),
        ),
      new Decimal(0),
    )
    .toDecimalPlaces(currencyDecimals(company.currency));
  const byType = new Map<string, Decimal>();
  for (const c of charges)
    byType.set(c.chargeType, (byType.get(c.chargeType) ?? new Decimal(0)).plus(dec(c.amount)));
  const total = [...byType.values()].reduce((a, v) => a.plus(v), new Decimal(0));
  return {
    currency: company.currency,
    goods,
    charges: charges.map((c) => ({
      id: c.id,
      chargeType: c.chargeType,
      method: c.method,
      currency: c.currency,
      enteredAmount: dec(c.enteredAmount),
      amount: dec(c.amount),
      capitalized: dec(c.capitalizedAmount),
      expensed: dec(c.expensedAmount),
      reference: c.reference,
      postedAt: c.postedAt,
      documents: c.landedCosts.map((l) => l.document.number),
    })),
    byType: CHARGES.filter((t) => byType.has(t)).map((t) => ({
      chargeType: t,
      amount: byType.get(t)!,
    })),
    totalCharges: total,
    landedTotal: goods.plus(total),
    /** Charges as a share of the goods' value; nothing without goods. */
    uplift: goods.isZero() ? null : total.div(goods),
    customsEntries: entries.map((e) => ({
      id: e.id,
      number: e.number,
      declaredOn: day(e.declaredOn),
      broker: e.broker,
      currency: e.currency,
      customsValue: e.customsValue === null ? null : dec(e.customsValue),
      dutyAmount: dec(e.dutyAmount),
      importVat: dec(e.importVat),
      dutyPosted: e.charges.reduce((a, c) => a.plus(dec(c.amount)), new Decimal(0)),
    })),
  };
}
