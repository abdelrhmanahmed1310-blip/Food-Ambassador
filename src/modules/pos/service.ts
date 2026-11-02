import "server-only";
import { z } from "zod";
import { Decimal, decimalString, toDecimal } from "@/lib/decimal";
import { assertPermission, accessibleScope, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { planConsumptionInTx, postConsumptionInTx } from "@/modules/inventory/consumption";
import { loadWarehouse } from "@/modules/inventory/context";
import { reverseDocumentInTx } from "@/modules/inventory/operations";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import {
  checkSelection,
  resolvePrice,
  SALES_CHANNELS,
  unitPrice,
  type SalesChannel,
} from "@/modules/menu/rules";
import { menuForBranch } from "@/modules/menu/service";
import { loadRecipeStructureInTx } from "@/modules/recipes/costs";
import { explodeRecipe } from "@/modules/recipes/explode";
import { codeSchema, optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import { loadTaxContextInTx } from "@/modules/tax/service";
import { issueCreditNoteInTx, issueOrderInvoiceInTx, receiptQrInTx } from "@/modules/zatca/service";
import { applyDiscounts, promotionFor, saleMoment, type OrderDiscount } from "./discounts";
import {
  loyaltySettingsInTx,
  orderCustomerInTx,
  postOrderPointsInTx,
  reverseOrderPointsInTx,
} from "./customers";
import { redeemGiftCardInTx, reverseGiftCardsInTx } from "./gift-cards";
import { createTicketsInTx, markVoidedInTx, orderStatusesInTx } from "./kitchen";
import { pointsValue } from "./loyalty-rules";
import {
  couponCodeSchema,
  loadPromotionsInTx,
  lookupCoupon,
  promotionForClient,
  takeCouponInTx,
} from "./promotions";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  checkPayments,
  expectedCash,
  lineAmounts,
  liveAt,
  orderTimeProblem,
  refundPortion,
} from "./rules";

/**
 * Point-of-sale selling (DECISIONS.md ADR-059): registers, shifts with cash
 * control, paid orders submitted whole by the device (its order id makes a
 * retry safe), stock used through recipes and options, voids in the open
 * shift, refunds, and shortfalls when the system shows less stock than was
 * sold — a sale is never refused for stock, and stock never goes negative.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const zero = () => new Decimal(0);
const money = decimalString({ maxScale: 4, min: "0" });
const positiveMoney = decimalString({ maxScale: 4, min: "0.0001" });

const site = (r: { branchId: string; warehouseId: string }) => ({
  branchId: r.branchId,
  warehouseId: r.warehouseId,
});

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  entityId: string,
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${entityType}.${action}`,
    entityType,
    entityId,
    changes,
  });
}

// ─── Registers ───

const registerSchema = z.object({
  branchId: uuidSchema,
  warehouseId: uuidSchema,
  code: codeSchema,
  name: requiredText(80),
});

export async function createRegister(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "pos.manage");
  const parsed = registerSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      if (wh.branchId !== input.branchId)
        throw businessRuleViolation(
          "REGISTER_WAREHOUSE_OTHER_BRANCH",
          "The stock warehouse must belong to the register's branch",
          { field: "warehouseId" },
        );
      if (wh.archived)
        throw businessRuleViolation("WAREHOUSE_ARCHIVED", "The warehouse is archived", {
          field: "warehouseId",
        });
      const r = await tx.posRegister.create({
        data: { organizationId: ctx.organizationId, ...input },
        select: { id: true, code: true },
      });
      await audit(tx, ctx, "pos_register", r.id, "created", input);
      return r;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("This code is already used", { reason: "codeTaken", field: "code" });
    throw error;
  }
}

/** Registers at the branches where the user may sell or see sales, with their open shift. */
export async function listRegisters(ctx: TenantContext) {
  const sell = accessibleScope(ctx.grants, "pos.sell");
  const view = accessibleScope(ctx.grants, "pos.view");
  const all = sell.all || view.all || hasPermission(ctx.grants, "pos.manage");
  const ids = (s: typeof sell, k: "branchIds" | "warehouseIds") => (s.all ? [] : s[k]);
  const branchIds = [...ids(sell, "branchIds"), ...ids(view, "branchIds")];
  const warehouseIds = [...ids(sell, "warehouseIds"), ...ids(view, "warehouseIds")];
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.posRegister.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(all
          ? {}
          : { OR: [{ branchId: { in: branchIds } }, { warehouseId: { in: warehouseIds } }] }),
      },
      include: {
        branch: { select: { code: true, name: true, timeZone: true } },
        warehouse: { select: { code: true, name: true } },
        shifts: { where: { status: "OPEN" }, select: { id: true, number: true, openedAt: true } },
      },
      orderBy: { code: "asc" },
    }),
  );
}

export async function loadRegister(tx: Tx, ctx: TenantContext, registerId: string) {
  const r = await tx.posRegister.findFirst({
    where: { organizationId: ctx.organizationId, id: registerId },
    include: { branch: { select: { timeZone: true, name: true, code: true } } },
  });
  if (!r) throw notFound("Register");
  if (
    !hasPermission(ctx.grants, "pos.sell", site(r)) &&
    !hasPermission(ctx.grants, "pos.view", site(r))
  )
    throw notFound("Register");
  return r;
}

// ─── Shifts ───

export async function openShift(ctx: TenantContext, registerId: string, rawInput: unknown) {
  const parsed = z.object({ openingFloat: money }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const r = await loadRegister(tx, ctx, registerId);
      assertPermission(ctx.grants, "pos.sell", site(r));
      if (r.archivedAt)
        throw businessRuleViolation("REGISTER_ARCHIVED", "The register is archived");
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "SHF",
        Number(businessDate(r.branch.timeZone ?? ctx.timeZone).slice(0, 4)),
      );
      const s = await tx.posShift.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          registerId: r.id,
          openingFloat: parsed.data.openingFloat,
          openedByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      await audit(tx, ctx, "pos_shift", s.id, "opened", {
        number,
        register: r.code,
        openingFloat: parsed.data.openingFloat,
      });
      return s;
    });
  } catch (error) {
    if (isUniqueViolation(error, "pos_shifts_one_open"))
      throw businessRuleViolation("SHIFT_ALREADY_OPEN", "This register already has an open shift");
    throw error;
  }
}

async function loadShift(
  tx: Tx,
  ctx: TenantContext,
  shiftId: string,
  options: { lock?: boolean } = {},
) {
  if (options.lock)
    await tx.$queryRaw`SELECT 1 FROM "pos_shifts" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${shiftId}::uuid FOR UPDATE`;
  const s = await tx.posShift.findFirst({
    where: { organizationId: ctx.organizationId, id: shiftId },
    include: {
      register: { include: { branch: { select: { timeZone: true, code: true, name: true } } } },
    },
  });
  if (!s) throw notFound("Shift");
  if (
    !hasPermission(ctx.grants, "pos.sell", site(s.register)) &&
    !hasPermission(ctx.grants, "pos.view", site(s.register))
  )
    throw notFound("Shift");
  return s;
}

const movementSchema = z.object({
  kind: z.enum(["PAY_IN", "PAY_OUT"], { error: "invalidOption" }),
  amount: positiveMoney,
  reason: requiredText(300),
});

/** Cash put into or taken out of the drawer during a shift (float top-up, petty cash). */
export async function addCashMovement(ctx: TenantContext, shiftId: string, rawInput: unknown) {
  const parsed = movementSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShift(tx, ctx, shiftId, { lock: true });
    assertPermission(ctx.grants, "pos.sell", site(s.register));
    if (s.status !== "OPEN") throw businessRuleViolation("SHIFT_CLOSED", "The shift is closed");
    const m = await tx.posCashMovement.create({
      data: {
        organizationId: ctx.organizationId,
        shiftId: s.id,
        ...parsed.data,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await audit(tx, ctx, "pos_shift", s.id, "cash_movement", { movementId: m.id, ...parsed.data });
  });
}

/** Cash and sales totals of a shift (the X report while open, the Z report once closed). */
async function shiftTotals(
  tx: Tx,
  ctx: TenantContext,
  shift: { id: string; openingFloat: unknown; closedAt?: Date | null },
) {
  const org = ctx.organizationId;
  const [orders, payments, refunds, movements, giftCards] = await inSequence([
    tx.posOrder.findMany({
      where: { organizationId: org, shiftId: shift.id },
      select: {
        createdAt: true,
        status: true,
        channel: true,
        netAmount: true,
        taxAmount: true,
        grossAmount: true,
        costAmount: true,
        promoDiscount: true,
        orderDiscount: true,
      },
    }),
    tx.posPayment.findMany({
      where: { organizationId: org, order: { shiftId: shift.id, status: "PAID" } },
      select: { method: true, amount: true, tip: true, order: { select: { createdAt: true } } },
    }),
    tx.posRefund.findMany({
      where: { organizationId: org, shiftId: shift.id },
      select: { method: true, amount: true, taxAmount: true },
    }),
    tx.posCashMovement.findMany({
      where: { organizationId: org, shiftId: shift.id },
      select: { kind: true, amount: true },
    }),
    tx.giftCard.findMany({
      where: { organizationId: org, shiftId: shift.id },
      select: { soldMethod: true, initialValue: true },
    }),
  ]);
  const sum = <T>(rows: T[], pick: (r: T) => unknown) =>
    rows.reduce((a, r) => a.plus(dec(pick(r) as Decimal)), zero());
  const paid = orders.filter((o) => o.status === "PAID");
  const voided = orders.filter((o) => o.status === "VOIDED");
  const byMethod = (m: "CASH" | "CARD") => ({
    sales: sum(
      payments.filter((p) => p.method === m),
      (p) => p.amount,
    ),
    refunds: sum(
      refunds.filter((r) => r.method === m),
      (r) => r.amount,
    ),
  });
  const cash = byMethod("CASH");
  const card = byMethod("CARD");
  // Gift cards sold in the shift: money taken, not sales (ADR-068).
  const giftSold = (m: "CASH" | "CARD") =>
    sum(
      giftCards.filter((g) => g.soldMethod === m),
      (g) => g.initialValue,
    );
  const payIns = sum(
    movements.filter((m) => m.kind === "PAY_IN"),
    (m) => m.amount,
  );
  const payOuts = sum(
    movements.filter((m) => m.kind === "PAY_OUT"),
    (m) => m.amount,
  );
  return {
    orders: paid.length,
    voids: { count: voided.length, gross: sum(voided, (o) => o.grossAmount) },
    net: sum(paid, (o) => o.netAmount).minus(
      sum(refunds, (r) => dec(r.amount).minus(dec(r.taxAmount))),
    ),
    tax: sum(paid, (o) => o.taxAmount).minus(sum(refunds, (r) => r.taxAmount)),
    gross: sum(paid, (o) => o.grossAmount).minus(sum(refunds, (r) => r.amount)),
    cost: sum(paid, (o) => o.costAmount),
    /** Discounts given on paid orders, incl. VAT (ADR-067). */
    discounts: {
      promotions: sum(paid, (o) => o.promoDiscount),
      orders: sum(paid, (o) => o.orderDiscount),
      count: paid.filter((o) => dec(o.orderDiscount).gt(0)).length,
    },
    byChannel: Object.fromEntries(
      SALES_CHANNELS.map((c) => [
        c,
        sum(
          paid.filter((o) => o.channel === c),
          (o) => o.grossAmount,
        ),
      ]),
    ),
    cash,
    card,
    /** Delivery orders paid to the platforms, settled by them later (ADR-069). */
    platforms: sum(
      payments.filter((p) => p.method === "DELIVERY_PLATFORM"),
      (p) => p.amount,
    ),
    giftCards: {
      soldCash: giftSold("CASH"),
      soldCard: giftSold("CARD"),
      count: giftCards.length,
      /** Orders paid from gift cards (part of the sales above). */
      redeemed: sum(
        payments.filter((p) => p.method === "GIFT_CARD"),
        (p) => p.amount,
      ),
    },
    /** Card tips: owed to staff, not sales (ADR-065). */
    tips: sum(payments, (p) => p.tip),
    refunds: { count: refunds.length, amount: sum(refunds, (r) => r.amount) },
    payIns,
    payOuts,
    /** Orders taken in the shift but synced after it closed (queued offline, ADR-060). */
    late: (() => {
      const closedAt = shift.closedAt;
      if (!closedAt) return { count: 0, gross: zero(), cash: zero() };
      const isLate = (d: Date) => d.getTime() > closedAt.getTime();
      const lateOrders = paid.filter((o) => isLate(o.createdAt));
      return {
        count: lateOrders.length,
        gross: sum(lateOrders, (o) => o.grossAmount),
        cash: sum(
          payments.filter((p) => p.method === "CASH" && isLate(p.order.createdAt)),
          (p) => p.amount,
        ),
      };
    })(),
    expectedCash: expectedCash({
      openingFloat: dec(shift.openingFloat as Decimal),
      cashSales: cash.sales.plus(giftSold("CASH")),
      cashRefunds: cash.refunds,
      payIns,
      payOuts,
    }),
  };
}

export async function closeShift(ctx: TenantContext, shiftId: string, rawInput: unknown) {
  const parsed = z.object({ countedCash: money, note: optionalText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShift(tx, ctx, shiftId, { lock: true });
    assertPermission(ctx.grants, "pos.sell", site(s.register));
    if (s.status !== "OPEN") throw businessRuleViolation("SHIFT_CLOSED", "The shift is closed");
    const totals = await shiftTotals(tx, ctx, s);
    const counted = toDecimal(parsed.data.countedCash);
    const difference = counted.minus(totals.expectedCash);
    await tx.posShift.update({
      where: { id: s.id },
      data: {
        status: "CLOSED",
        expectedCash: totals.expectedCash.toFixed(),
        countedCash: counted.toFixed(),
        cashDifference: difference.toFixed(),
        closeNote: parsed.data.note ?? null,
        closedByUserId: ctx.userId,
        closedAt: new Date(),
      },
    });
    await audit(tx, ctx, "pos_shift", s.id, "closed", {
      number: s.number,
      expected: totals.expectedCash.toFixed(),
      counted: counted.toFixed(),
      difference: difference.toFixed(),
      gross: totals.gross.toFixed(),
    });
  });
}

export async function getShift(ctx: TenantContext, shiftId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShift(tx, ctx, shiftId);
    const totals = await shiftTotals(tx, ctx, s);
    const [orders, movements] = await inSequence([
      tx.posOrder.findMany({
        where: { organizationId: ctx.organizationId, shiftId: s.id },
        select: {
          id: true,
          number: true,
          status: true,
          channel: true,
          grossAmount: true,
          refundedAmount: true,
          orderedAt: true,
        },
        orderBy: { orderedAt: "desc" },
        take: 200,
      }),
      tx.posCashMovement.findMany({
        where: { organizationId: ctx.organizationId, shiftId: s.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const kitchen = await orderStatusesInTx(
      tx,
      ctx,
      orders.map((o) => o.id),
    );
    return {
      ...s,
      totals,
      orders: orders.map((o) => ({ ...o, kitchen: kitchen.get(o.id) ?? null })),
      movements,
      can: {
        sell: s.status === "OPEN" && hasPermission(ctx.grants, "pos.sell", site(s.register)),
      },
    };
  });
}

// ─── Orders ───

export const orderSchema = z
  .object({
    /** Generated by the device; a retry with the same id returns the same order. */
    orderId: uuidSchema,
    registerId: uuidSchema,
    channel: z.enum(SALES_CHANNELS, { error: "invalidOption" }),
    lines: z
      .array(
        z.object({
          itemId: uuidSchema,
          quantity: decimalString({ maxScale: 3, min: "0.001", max: "999" }),
          optionIds: z.array(uuidSchema).max(40).default([]),
        }),
      )
      .min(1, { error: "required" })
      .max(200),
    payments: z
      .array(
        z.object({
          method: z.enum(["CASH", "CARD", "GIFT_CARD"], { error: "invalidOption" }),
          amount: positiveMoney,
          /** Gift card payments: the card's code (ADR-068). */
          giftCardCode: z.string().trim().max(30).optional(),
          tendered: positiveMoney.optional(),
          reference: optionalText(60),
          /** From the card terminal's slip (POS3a); only the last 4 digits of the card. */
          cardScheme: z
            .enum(["MADA", "VISA", "MASTERCARD", "AMEX", "OTHER"], { error: "invalidOption" })
            .optional(),
          terminalId: optionalText(20),
          approvalCode: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9]{1,12}$/, { error: "invalid" })
            .optional(),
          cardLast4: z
            .string()
            .regex(/^\d{4}$/, { error: "invalid" })
            .optional(),
          /** Tip charged on the card on top of the amount: not a sale, no VAT. */
          tip: money.optional(),
        }),
      )
      .max(10),
    /** A manual discount on the whole order (needs pos.discount and a reason; ADR-067). */
    discount: z
      .object({
        kind: z.enum(["PERCENT", "AMOUNT"], { error: "invalidOption" }),
        value: positiveMoney,
        reason: requiredText(120),
      })
      .optional(),
    /** A coupon code for a discount on the whole order. */
    couponCode: couponCodeSchema.optional(),
    /** The customer (POS5b, ADR-068): earns points; may spend points as the order discount. */
    customerId: uuidSchema.optional(),
    loyaltyPoints: z.coerce.number().int().min(1).max(10_000_000).optional(),
    /** The total the cashier saw; the order is refused if the server's differs (prices changed). */
    expectedTotal: money.optional(),
    /** When the order was taken on the device (offline orders, POS1c); default now. */
    orderedAt: z.iso.datetime({ offset: true }).optional(),
    /** The shift the device sold in; an order queued offline may arrive after it closed. */
    shiftId: uuidSchema.optional(),
    /** When the device loaded its menu: prices and items are taken as they were then (ADR-060). */
    menuAsOf: z.iso.datetime({ offset: true }).optional(),
    /** Who took the order on the device; it is recorded only under that person's session. */
    cashierUserId: uuidSchema.optional(),
    note: optionalText(300),
  })
  .refine((v) => [v.discount, v.couponCode, v.loyaltyPoints].filter(Boolean).length <= 1, {
    error: "discountAndCoupon",
    path: ["couponCode"],
  })
  .refine((v) => !v.loyaltyPoints || v.customerId, {
    error: "required",
    path: ["customerId"],
  })
  .refine((v) => v.discount?.kind !== "PERCENT" || toDecimal(v.discount.value).lte(100), {
    error: "invalid",
    path: ["discount", "value"],
  });

type MenuLoad = Awaited<ReturnType<typeof loadMenuItems>>;

/** Menu items as they were on a menu loaded at `asOf`: later prices and withdrawals do not apply. */
async function loadMenuItems(
  tx: Tx,
  ctx: TenantContext,
  ids: string[],
  branchId: string,
  asOf: Date,
) {
  const live = { OR: [{ archivedAt: null }, { archivedAt: { gt: asOf } }] };
  return tx.menuItem.findMany({
    where: { organizationId: ctx.organizationId, id: { in: ids } },
    include: {
      category: { select: { archivedAt: true } },
      prices: {
        where: { OR: [{ branchId: null }, { branchId }], createdAt: { lte: asOf } },
      },
      recipe: {
        select: {
          id: true,
          code: true,
          type: true,
          taxCodeId: true,
          versions: { where: { status: "ACTIVE" }, select: { id: true } },
        },
      },
      modifierGroups: {
        include: {
          group: {
            include: {
              options: {
                where: live,
                include: {
                  recipe: {
                    select: {
                      id: true,
                      code: true,
                      type: true,
                      versions: { where: { status: "ACTIVE" }, select: { id: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        include: {
          component: {
            include: {
              recipe: {
                select: {
                  id: true,
                  code: true,
                  type: true,
                  versions: { where: { status: "ACTIVE" }, select: { id: true } },
                },
              },
            },
          },
        },
      },
      unavailable: { where: { branchId, createdAt: { lte: asOf } } },
    },
  });
}

type RecipeRef = { id: string; code: string; type: string; versions: Array<{ id: string }> } | null;

/** What one unit of a menu item uses: recipes (with portions or yield units) and products. */
function itemUsage(item: MenuLoad[number]) {
  const recipes: Array<{ recipe: NonNullable<RecipeRef>; quantity: Decimal }> = [];
  const products: Array<{ productId: string; quantity: Decimal }> = [];
  const addItem = (
    i: { recipe: RecipeRef; productId: string | null; productQuantity: unknown },
    q: Decimal,
  ) => {
    if (i.recipe) recipes.push({ recipe: i.recipe, quantity: q });
    else if (i.productId)
      products.push({
        productId: i.productId,
        quantity: dec(i.productQuantity as Decimal).times(q),
      });
  };
  if (item.kind === "COMBO") for (const c of item.components) addItem(c.component, dec(c.quantity));
  else addItem(item, new Decimal(1));
  return { recipes, products };
}

export interface LineInput {
  itemId: string;
  quantity: string;
  optionIds: string[];
}

/**
 * Price order lines from the menu on a business date (as a till that loaded
 * its menu at `asOf` saw it), with VAT per line, and collect the stock they
 * use (recipes not yet exploded). Refuses items not on sale, wrong options
 * and missing VAT rates. Shared by counter orders, checks and kitchen waste.
 */
export async function priceLinesInTx(
  tx: Tx,
  ctx: TenantContext,
  a: {
    lines: LineInput[];
    channel: SalesChannel;
    branchId: string;
    date: string;
    asOf: Date;
    /** Per line: the unit price (VAT included, options included) a delivery platform charged. */
    unitPrices?: Array<string | undefined>;
  },
) {
  const items = new Map(
    (
      await loadMenuItems(tx, ctx, [...new Set(a.lines.map((l) => l.itemId))], a.branchId, a.asOf)
    ).map((i) => [i.id, i]),
  );
  const taxes = await loadTaxContextInTx(tx, ctx, { branchId: a.branchId });
  const lines: Array<{
    lineNo: number;
    menuItemId: string;
    name: string;
    quantity: string;
    unitPrice: string;
    priceIncludesTax: boolean;
    options: Array<{ optionId: string; name: string; priceDelta: string }>;
    taxCodeId: string | null;
    taxRate: string | null;
    netAmount: string;
    taxAmount: string;
    grossAmount: string;
  }> = [];
  const recipeUse: Array<{
    versionId: string;
    asPortions: boolean;
    quantity: Decimal;
    code: string;
  }> = [];
  const productUse = new Map<string, Decimal>();
  const addProduct = (id: string, q: Decimal) =>
    productUse.set(id, (productUse.get(id) ?? zero()).plus(q));
  const addRecipeUse = (r: NonNullable<RecipeRef>, q: Decimal, field: string) => {
    const version = r.versions[0];
    if (!version)
      throw businessRuleViolation(
        "MENU_RECIPE_NOT_READY",
        "A recipe on this order has no active version",
        {
          field,
          code: r.code,
        },
      );
    recipeUse.push({
      versionId: version.id,
      asPortions: r.type === "DISH",
      quantity: q,
      code: r.code,
    });
  };
  for (const [index, l] of a.lines.entries()) {
    const field = `lines.${index}.itemId`;
    const item = items.get(l.itemId);
    if (
      !item ||
      !liveAt(item.archivedAt, a.asOf) ||
      !liveAt(item.category.archivedAt, a.asOf) ||
      item.unavailable.length > 0
    )
      throw businessRuleViolation("MENU_ITEM_NOT_SOLD", "This item is not on sale here", {
        field,
      });
    const charged = a.unitPrices?.[index];
    const price = charged
      ? { price: toDecimal(charged), includesTax: true }
      : resolvePrice(
          item.prices.map((p) => ({
            channel: p.channel,
            branchId: p.branchId,
            price: dec(p.price),
            includesTax: p.includesTax,
            effectiveFrom: p.effectiveFrom.toISOString().slice(0, 10),
          })),
          { channel: a.channel, branchId: a.branchId, date: a.date },
        );
    if (!price)
      throw businessRuleViolation("MENU_ITEM_NOT_SOLD", "This item has no price on this channel", {
        field,
      });
    const groups = item.modifierGroups.filter((m) => liveAt(m.group.archivedAt, a.asOf));
    const problems = checkSelection(
      groups.map((m) => ({
        groupId: m.groupId,
        minSelect: m.group.minSelect,
        maxSelect: m.group.maxSelect,
        optionIds: m.group.options.map((o) => o.id),
      })),
      l.optionIds,
    );
    if (problems.length > 0)
      throw businessRuleViolation("MODIFIER_SELECTION", "Choose the options this item needs", {
        field: `lines.${index}.optionIds`,
        problem: problems[0].problem,
      });
    const options = [...new Set(l.optionIds)].map((id) =>
      groups.flatMap((m) => m.group.options).find((o) => o.id === id)!,
    );
    // A platform's price already includes the options.
    const unit = charged
      ? price.price
      : unitPrice(
          price.price,
          options.map((o) => dec(o.priceDelta)),
        );
    const quantity = toDecimal(l.quantity);
    const resolved = taxes.resolve(item.taxCodeId ?? item.recipe?.taxCodeId, a.date);
    if (resolved && !resolved.ok)
      throw businessRuleViolation(
        resolved.problem === "noTaxRate" ? "NO_TAX_RATE" : "UNKNOWN_TAX_CODE",
        "VAT code or rate missing",
        { field, code: resolved.code },
      );
    const amounts = lineAmounts(
      unit,
      quantity,
      price.includesTax,
      resolved ? resolved.rate : null,
      ctx.baseCurrency,
    );
    lines.push({
      lineNo: index + 1,
      menuItemId: item.id,
      name: item.name,
      quantity: quantity.toFixed(),
      unitPrice: unit.toFixed(),
      priceIncludesTax: price.includesTax,
      options: options.map((o) => ({
        optionId: o.id,
        name: o.name,
        priceDelta: dec(o.priceDelta).toFixed(),
      })),
      taxCodeId: resolved ? resolved.codeId : null,
      taxRate: resolved ? resolved.rate.toFixed() : null,
      netAmount: amounts.net.toFixed(),
      taxAmount: amounts.tax.toFixed(),
      grossAmount: amounts.gross.toFixed(),
    });
    // What it uses from stock.
    const use = itemUsage(item);
    for (const r of use.recipes) addRecipeUse(r.recipe, r.quantity.times(quantity), field);
    for (const p of use.products) addProduct(p.productId, p.quantity.times(quantity));
    for (const o of options) {
      if (!o.quantity) continue;
      const q = dec(o.quantity).times(quantity);
      if (o.recipe) addRecipeUse(o.recipe, q, `lines.${index}.optionIds`);
      else if (o.productId) addProduct(o.productId, q);
    }
  }
  return { lines, recipeUse, productUse };
}

/** Explode recipe use into products and add it to the product use. */
export async function explodeUseInTx(
  tx: Tx,
  ctx: TenantContext,
  recipeUse: Array<{ versionId: string; asPortions: boolean; quantity: Decimal; code: string }>,
  productUse: Map<string, Decimal>,
) {
  const structures = await loadRecipeStructureInTx(
    tx,
    ctx,
    recipeUse.map((r) => r.versionId),
  );
  for (const r of recipeUse) {
    const st = structures.get(r.versionId)!;
    const e = explodeRecipe(st.root, st.world, r.quantity, r.asPortions);
    if (e.problems.length > 0)
      throw businessRuleViolation(
        "MENU_RECIPE_NOT_READY",
        "A recipe on this order cannot be used",
        {
          code: e.problems[0].recipeCode,
          problem: e.problems[0].kind,
        },
      );
    for (const [id, q] of e.usage) productUse.set(id, (productUse.get(id) ?? zero()).plus(q));
  }
  return productUse;
}

export async function submitOrder(ctx: TenantContext, rawInput: unknown) {
  const parsed = orderSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, (tx) => recordOrderInTx(tx, ctx, parsed.data));
  } catch (error) {
    if (isUniqueViolation(error, "pos_orders_pkey"))
      throw conflict("This order was already recorded", { reason: "duplicate" });
    throw error;
  }
}

type OrderInput = z.infer<typeof orderSchema>;

/**
 * Record a paid order (counter sale, or all or part of a check — `tab`): price
 * it, check payments, use stock, write the order. Retries with the same id
 * return the recorded order.
 */
export async function recordOrderInTx(
  tx: Tx,
  ctx: TenantContext,
  input: OrderInput,
  tab?: { tabId: string; warehouseId: string; tabLineIds: string[]; lineTimes: Date[] } | null,
  /**
   * Orders from a delivery platform (ADR-069), built by the server only: the
   * platform's prices, its restaurant-funded discount, and payment to the
   * platform. Never reachable from a device's request.
   */
  platform?: { unitPrices: string[]; discountReason: string; label: string },
) {
  const org = ctx.organizationId;
  // A retry of an order already recorded returns it unchanged.
  const existing = await tx.posOrder.findFirst({
    where: { organizationId: org, id: input.orderId },
    include: { payments: true },
  });
  if (existing)
    return {
      id: existing.id,
      number: existing.number,
      gross: dec(existing.grossAmount),
      change: existing.payments.reduce((a, p) => a.plus(dec(p.change ?? 0)), zero()),
      shortfalls: 0,
      duplicate: true,
    };
  if (input.cashierUserId && input.cashierUserId !== ctx.userId)
    throw forbidden("This order was taken by someone else; they must be signed in to send it");
  const register = await loadRegister(tx, ctx, input.registerId);
  assertPermission(ctx.grants, "pos.sell", site(register));
  const shift = input.shiftId
    ? await tx.posShift.findFirst({
        where: { organizationId: org, id: input.shiftId, registerId: register.id },
      })
    : await tx.posShift.findFirst({
        where: { organizationId: org, registerId: register.id, status: "OPEN" },
      });
  if (!shift) {
    if (input.shiftId) throw notFound("Shift");
    throw businessRuleViolation("SHIFT_NOT_OPEN", "Open a shift on this register first");
  }
  const now = new Date();
  const orderedAt = input.orderedAt ? new Date(input.orderedAt) : now;
  const asOf = input.menuAsOf ? new Date(input.menuAsOf) : now;
  const timeProblem = orderTimeProblem({
    orderedAt,
    menuAsOf: asOf,
    now,
    openedAt: shift.openedAt,
    closedAt: shift.status === "CLOSED" ? shift.closedAt : null,
  });
  if (timeProblem)
    throw businessRuleViolation(
      timeProblem,
      timeProblem === "ORDER_TIME_OUTSIDE_SHIFT"
        ? "The order time is outside the shift"
        : "The menu time is not within the shift",
      { field: "orderedAt" },
    );
  const tz = register.branch.timeZone ?? ctx.timeZone;
  const date = businessDate(tz, orderedAt);

  const priced = await priceLinesInTx(tx, ctx, {
    lines: input.lines,
    channel: input.channel,
    branchId: register.branchId,
    date,
    asOf,
    unitPrices: platform?.unitPrices,
  });
  const { recipeUse, productUse } = priced;
  // Discounts (ADR-067): promotions live on the till's menu, at the time each item was ordered.
  // A platform's prices are final: our promotions do not apply to them.
  const promotions = platform ? [] : await loadPromotionsInTx(tx, ctx, asOf);
  const categories = new Map(
    (
      await tx.menuItem.findMany({
        where: { organizationId: org, id: { in: priced.lines.map((l) => l.menuItemId) } },
        select: { id: true, categoryId: true },
      })
    ).map((i) => [i.id, i.categoryId]),
  );
  const promos = priced.lines.map((l, i) =>
    promotionFor(
      { id: l.menuItemId, categoryId: categories.get(l.menuItemId)! },
      saleMoment(input.channel, tz, tab?.lineTimes[i] ?? orderedAt),
      promotions,
    ),
  );
  let orderDiscount: OrderDiscount | null = null;
  let coupon: { id: string } | null = null;
  const customer = input.customerId
    ? await orderCustomerInTx(tx, ctx, input.customerId, Boolean(input.loyaltyPoints))
    : null;
  if (customer && input.loyaltyPoints) {
    const loyalty = await loyaltySettingsInTx(tx, ctx);
    if (!loyalty?.enabled)
      throw businessRuleViolation("LOYALTY_OFF", "Loyalty points are not in use", {
        field: "loyaltyPoints",
      });
    if (input.loyaltyPoints < loyalty.minRedeemPoints)
      throw businessRuleViolation("POINTS_BELOW_MINIMUM", "Spend at least the minimum points", {
        field: "loyaltyPoints",
        minimum: loyalty.minRedeemPoints,
      });
    if (input.loyaltyPoints > customer.pointsBalance)
      throw businessRuleViolation("POINTS_NOT_ENOUGH", "The customer does not have these points", {
        field: "loyaltyPoints",
      });
    orderDiscount = {
      kind: "AMOUNT",
      value: pointsValue(input.loyaltyPoints, loyalty.pointValue, ctx.baseCurrency),
    };
  }
  if (input.discount) {
    if (!platform) assertPermission(ctx.grants, "pos.discount", site(register));
    orderDiscount = { kind: input.discount.kind, value: toDecimal(input.discount.value) };
  } else if (input.couponCode) {
    const c = await takeCouponInTx(tx, ctx, input.couponCode, date);
    coupon = c;
    orderDiscount = { kind: c.kind, value: c.value };
  }
  const discounted = applyDiscounts(
    priced.lines.map((l, i) => ({
      gross: toDecimal(l.grossAmount),
      rate: l.taxRate === null ? null : toDecimal(l.taxRate),
      promoPercent: promos[i]?.percent ?? null,
    })),
    orderDiscount,
    ctx.baseCurrency,
  );
  if (input.loyaltyPoints && orderDiscount && discounted.orderDiscount.lt(orderDiscount.value))
    throw businessRuleViolation(
      "POINTS_MORE_THAN_ORDER",
      "These points are worth more than the order",
      {
        field: "loyaltyPoints",
      },
    );
  if (coupon && discounted.orderDiscount.isZero())
    throw businessRuleViolation("COUPON_NOTHING_OFF", "This coupon takes nothing off", {
      field: "couponCode",
    });
  const lines = priced.lines.map((l, i) => ({
    ...l,
    netAmount: discounted.lines[i].net.toFixed(),
    taxAmount: discounted.lines[i].tax.toFixed(),
    grossAmount: discounted.lines[i].gross.toFixed(),
    discountAmount: discounted.lines[i].discount.toFixed(),
    promotionId: promos[i]?.id ?? null,
  }));
  const total = (k: "netAmount" | "taxAmount" | "grossAmount") =>
    lines.reduce((a, l) => a.plus(toDecimal(l[k])), zero());
  const gross = total("grossAmount");
  if (input.expectedTotal !== undefined && !toDecimal(input.expectedTotal).equals(gross))
    throw businessRuleViolation("ORDER_PRICES_CHANGED", "Prices changed; refresh the menu", {
      expected: input.expectedTotal,
      total: gross.toFixed(),
    });
  const payments = input.payments.map((p) => ({
    method: p.method,
    giftCardCode: p.giftCardCode,
    amount: toDecimal(p.amount),
    tendered: p.tendered === undefined ? undefined : toDecimal(p.tendered),
    reference: p.reference,
    card: {
      cardScheme: p.cardScheme ?? null,
      terminalId: p.terminalId ?? null,
      approvalCode: p.approvalCode ?? null,
      cardLast4: p.cardLast4 ?? null,
    },
    tip: toDecimal(p.tip ?? "0"),
  }));
  for (const [index, p] of payments.entries()) {
    if (p.method !== "CARD" && (p.tip.gt(0) || Object.values(p.card).some((v) => v !== null)))
      throw businessRuleViolation(
        "PAYMENT_CARD_DETAILS_ON_CASH",
        "Card details and tips belong to card payments",
        { field: `payments.${index}` },
      );
    if ((p.method === "GIFT_CARD") !== Boolean(p.giftCardCode))
      throw businessRuleViolation("GIFT_CARD_UNKNOWN", "Enter the gift card's code", {
        field: `payments.${index}.giftCardCode`,
      });
  }
  const pay = checkPayments(gross, payments);
  if (pay.problems.length > 0)
    throw businessRuleViolation(pay.problems[0], "The payments do not settle the order", {
      field: "payments",
      total: gross.toFixed(),
    });

  // Stock: recipes exploded into products, then FEFO; what is missing becomes a shortfall.
  await explodeUseInTx(tx, ctx, recipeUse, productUse);
  const wh = await loadWarehouse(tx, ctx, tab?.warehouseId ?? register.warehouseId, "pos.sell");
  const plan = await planConsumptionInTx(tx, ctx, wh, productUse, { partial: true });

  const number = await nextDocumentNumber(tx, org, "POS", Number(date.slice(0, 4)));
  await tx.posOrder.create({
    data: {
      id: input.orderId,
      organizationId: org,
      number,
      registerId: register.id,
      shiftId: shift.id,
      branchId: register.branchId,
      warehouseId: wh.id,
      channel: input.channel,
      tabId: tab?.tabId ?? null,
      orderedAt,
      businessDate: new Date(`${date}T00:00:00Z`),
      netAmount: total("netAmount").toFixed(),
      taxAmount: total("taxAmount").toFixed(),
      grossAmount: gross.toFixed(),
      promoDiscount: discounted.promoDiscount.toFixed(),
      orderDiscount: discounted.orderDiscount.toFixed(),
      discountReason: input.discount?.reason ?? null,
      couponId: coupon?.id ?? null,
      customerId: customer?.id ?? null,
      loyaltyPoints: input.loyaltyPoints ?? 0,
      note: input.note,
      cashierUserId: ctx.userId,
    },
  });
  await tx.posOrderLine.createMany({
    data: lines.map((l, i) => ({
      ...l,
      organizationId: org,
      orderId: input.orderId,
      tabLineId: tab?.tabLineIds[i] ?? null,
    })),
  });
  // A counter order goes to the kitchen now; a check's items went when they were sent.
  if (!tab) {
    const created = await tx.posOrderLine.findMany({
      where: { organizationId: org, orderId: input.orderId },
      select: { id: true, menuItemId: true, name: true, quantity: true, options: true },
      orderBy: { lineNo: "asc" },
    });
    await createTicketsInTx(
      tx,
      ctx,
      { branchId: register.branchId, orderId: input.orderId, label: platform?.label ?? number },
      created.map((l) => ({
        orderLineId: l.id,
        menuItemId: l.menuItemId,
        name: l.name,
        quantity: dec(l.quantity),
        options: (l.options as Array<{ name: string }>).map((o) => o.name),
      })),
    );
  }
  // Gift cards are spent (locked, balance checked) before their payments are written.
  const giftCardIds: Array<string | null> = [];
  for (const [index, p] of payments.entries())
    giftCardIds.push(
      p.method === "GIFT_CARD"
        ? await redeemGiftCardInTx(
            tx,
            ctx,
            p.giftCardCode!,
            p.amount,
            input.orderId,
            `payments.${index}.giftCardCode`,
          )
        : null,
    );
  await tx.posPayment.createMany({
    data: payments.map((p, index) => ({
      organizationId: org,
      orderId: input.orderId,
      giftCardId: giftCardIds[index],
      method: p.method,
      amount: p.amount.toFixed(),
      tendered: p.tendered?.toFixed() ?? null,
      change: p.tendered ? p.tendered.minus(p.amount).toFixed() : null,
      reference: p.reference ?? null,
      ...p.card,
      tip: p.tip.toFixed(),
    })),
  });
  let cost = zero();
  let documentId: string | null = null;
  if (plan.picks.length > 0) {
    const posted = await postConsumptionInTx(tx, ctx, wh, plan.picks, `POS ${number}`);
    cost = posted.cost;
    documentId = posted.documentId;
  }
  if (plan.shortages.length > 0)
    await tx.posConsumptionShortfall.createMany({
      data: plan.shortages.map((s) => ({
        organizationId: org,
        orderId: input.orderId,
        warehouseId: wh.id,
        productId: s.productId,
        quantity: s.required.minus(s.available).toFixed(),
      })),
    });
  if (documentId)
    await tx.posOrder.update({
      where: { id: input.orderId },
      data: { costAmount: cost.toFixed(), consumptionDocId: documentId },
    });
  const pointsEarned = customer
    ? await postOrderPointsInTx(tx, ctx, {
        customerId: customer.id,
        orderId: input.orderId,
        redeemed: input.loyaltyPoints ?? 0,
        paid: gross,
      })
    : 0;
  // ZATCA: the signed simplified tax invoice, once the register's unit is onboarded (ADR-064).
  await issueOrderInvoiceInTx(tx, ctx, input.orderId);
  await audit(tx, ctx, "pos_order", input.orderId, "paid", {
    number,
    gross: gross.toFixed(),
    lines: lines.length,
    ...(discounted.promoDiscount.gt(0)
      ? { promoDiscount: discounted.promoDiscount.toFixed() }
      : {}),
    ...(discounted.orderDiscount.gt(0)
      ? {
          orderDiscount: discounted.orderDiscount.toFixed(),
          discountReason: input.discount?.reason ?? null,
          coupon: input.couponCode ?? null,
        }
      : {}),
    payments: payments.map((p) => ({ method: p.method, amount: p.amount.toFixed() })),
    shortfalls: plan.shortages.length,
    orderedAt: orderedAt.toISOString(),
    menuAsOf: asOf.toISOString(),
    syncedAfterShiftClosed: shift.status === "CLOSED",
    ...(customer
      ? { customer: customer.id, pointsEarned, pointsSpent: input.loyaltyPoints ?? 0 }
      : {}),
  });
  return {
    id: input.orderId,
    number,
    gross,
    change: pay.change,
    shortfalls: plan.shortages.length,
    duplicate: false,
  };
}

async function loadOrder(
  tx: Tx,
  ctx: TenantContext,
  orderId: string,
  options: { lock?: boolean } = {},
) {
  if (options.lock)
    await tx.$queryRaw`SELECT 1 FROM "pos_orders" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${orderId}::uuid FOR UPDATE`;
  const o = await tx.posOrder.findFirst({
    where: { organizationId: ctx.organizationId, id: orderId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      refunds: { orderBy: { createdAt: "asc" } },
      shortfalls: { include: { product: { select: { sku: true, nameEn: true } } } },
      shift: { select: { id: true, number: true, status: true } },
      register: { select: { id: true, code: true, name: true } },
      coupon: { select: { code: true } },
      customer: { select: { id: true, name: true, pointsBalance: true } },
      payments: { include: { giftCard: { select: { last4: true } } } },
    },
  });
  if (!o) throw notFound("Order");
  if (
    !hasPermission(ctx.grants, "pos.sell", site(o)) &&
    !hasPermission(ctx.grants, "pos.view", site(o))
  )
    throw notFound("Order");
  return o;
}

/** Cancel a paid order in its open shift: stock goes back, the money is not counted. */
export async function voidOrder(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const o = await loadOrder(tx, ctx, orderId, { lock: true });
    assertPermission(ctx.grants, "pos.void", site(o));
    if (o.status !== "PAID")
      throw businessRuleViolation("ORDER_VOIDED", "The order is already voided");
    if (o.shift.status !== "OPEN")
      throw businessRuleViolation(
        "VOID_SHIFT_CLOSED",
        "Orders of a closed shift are refunded, not voided",
      );
    if (dec(o.refundedAmount).gt(0))
      throw businessRuleViolation(
        "ORDER_REFUNDED",
        "Part of this order was refunded; refund the rest instead",
      );
    let voidDocId: string | null = null;
    if (o.consumptionDocId)
      voidDocId = (
        await reverseDocumentInTx(
          tx,
          ctx,
          o.consumptionDocId,
          { reasonCode: "ENTERED_IN_ERROR", note: `Void ${o.number}: ${parsed.data.reason}` },
          { allowReceipt: false, allowConsumption: true, permission: "pos.void" },
        )
      ).documentId;
    // Stock posted later for its shortfalls goes back too.
    for (const sf of o.shortfalls)
      if (sf.status === "POSTED" && sf.documentId)
        await reverseDocumentInTx(
          tx,
          ctx,
          sf.documentId,
          { reasonCode: "ENTERED_IN_ERROR", note: `Void ${o.number}: ${parsed.data.reason}` },
          { allowReceipt: false, allowConsumption: true, permission: "pos.void" },
        );
    await tx.posConsumptionShortfall.updateMany({
      where: { organizationId: ctx.organizationId, orderId: o.id, status: "OPEN" },
      data: { status: "CANCELLED", resolvedAt: new Date() },
    });
    await markVoidedInTx(tx, ctx, { orderLineIds: o.lines.map((l) => l.id) });
    // Gift cards get their money back; points earned go and points spent come back.
    await reverseGiftCardsInTx(tx, ctx, o.id);
    await reverseOrderPointsInTx(tx, ctx, o, null);
    // A reported invoice is corrected by a credit note for the whole order.
    await issueCreditNoteInTx(tx, ctx, { orderId: o.id, reason: parsed.data.reason });
    await tx.posOrder.update({
      where: { id: o.id },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: parsed.data.reason,
        voidDocId,
      },
    });
    await audit(tx, ctx, "pos_order", o.id, "voided", {
      number: o.number,
      reason: parsed.data.reason,
    });
  });
}

const refundSchema = z.object({
  /** The register whose open shift pays the refund out. */
  registerId: uuidSchema,
  method: z.enum(["CASH", "CARD"], { error: "invalidOption" }),
  reason: requiredText(500),
  /** Card refunds: the terminal's reference. */
  reference: optionalText(40),
  lines: z
    .array(
      z.object({ orderLineId: uuidSchema, quantity: decimalString({ maxScale: 3, min: "0" }) }),
    )
    .min(1)
    .max(200),
});

/** Give money back for some or all of a paid order. Food is not returned to stock. */
export async function refundOrder(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = refundSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const o = await loadOrder(tx, ctx, orderId, { lock: true });
    assertPermission(ctx.grants, "pos.refund", site(o));
    if (o.status !== "PAID") throw businessRuleViolation("ORDER_VOIDED", "The order is voided");
    const register = await loadRegister(tx, ctx, input.registerId);
    if (register.branchId !== o.branchId)
      throw businessRuleViolation(
        "REFUND_OTHER_BRANCH",
        "Refund at a register of the order's branch",
        {
          field: "registerId",
        },
      );
    const shift = await tx.posShift.findFirst({
      where: { organizationId: ctx.organizationId, registerId: register.id, status: "OPEN" },
    });
    if (!shift)
      throw businessRuleViolation("SHIFT_NOT_OPEN", "Open a shift on this register first");
    // What each line has already given back.
    const done = new Map<string, { quantity: Decimal; gross: Decimal; tax: Decimal }>();
    for (const r of o.refunds)
      for (const x of r.lines as Array<{
        orderLineId: string;
        quantity: string;
        gross: string;
        tax: string;
      }>) {
        const d = done.get(x.orderLineId) ?? { quantity: zero(), gross: zero(), tax: zero() };
        done.set(x.orderLineId, {
          quantity: d.quantity.plus(x.quantity),
          gross: d.gross.plus(x.gross),
          tax: d.tax.plus(x.tax),
        });
      }
    const parts = [];
    for (const [index, l] of input.lines.entries()) {
      const q = toDecimal(l.quantity);
      if (q.isZero()) continue;
      const line = o.lines.find((x) => x.id === l.orderLineId);
      if (!line) throw notFound("Order line");
      const portion = refundPortion(
        { quantity: dec(line.quantity), gross: dec(line.grossAmount), tax: dec(line.taxAmount) },
        done.get(line.id) ?? { quantity: zero(), gross: zero(), tax: zero() },
        q,
        ctx.baseCurrency,
      );
      if (!portion)
        throw businessRuleViolation("REFUND_EXCEEDS_LINE", "More than is left on this line", {
          field: `lines.${index}.quantity`,
        });
      parts.push({ line, quantity: q, ...portion });
    }
    if (parts.length === 0)
      throw businessRuleViolation("NOTHING_TO_REFUND", "Enter a quantity to refund");
    const amount = parts.reduce((a, p) => a.plus(p.gross), zero());
    const tax = parts.reduce((a, p) => a.plus(p.tax), zero());
    if (!amount.gt(0)) throw businessRuleViolation("NOTHING_TO_REFUND", "Nothing to refund");
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "RFD",
      Number(businessDate(register.branch.timeZone ?? ctx.timeZone).slice(0, 4)),
    );
    const refund = await tx.posRefund.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        orderId: o.id,
        shiftId: shift.id,
        method: input.method,
        amount: amount.toFixed(),
        taxAmount: tax.toFixed(),
        lines: parts.map((p) => ({
          orderLineId: p.line.id,
          quantity: p.quantity.toFixed(),
          gross: p.gross.toFixed(),
          tax: p.tax.toFixed(),
        })),
        reason: input.reason,
        reference: input.method === "CARD" ? (input.reference ?? null) : null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    for (const p of parts)
      await tx.posOrderLine.update({
        where: { id: p.line.id },
        data: { refundedQuantity: dec(p.line.refundedQuantity).plus(p.quantity).toFixed() },
      });
    await reverseOrderPointsInTx(tx, ctx, o, amount);
    await tx.posOrder.update({
      where: { id: o.id },
      data: { refundedAmount: dec(o.refundedAmount).plus(amount).toFixed() },
    });
    await issueCreditNoteInTx(tx, ctx, {
      orderId: o.id,
      refundId: refund.id,
      reason: input.reason,
      registerId: register.id,
      method: input.method,
    });
    await audit(tx, ctx, "pos_order", o.id, "refunded", {
      number: o.number,
      refund: number,
      amount: amount.toFixed(),
      method: input.method,
      reason: input.reason,
    });
    return { ...refund, amount };
  });
}

export async function getOrder(ctx: TenantContext, orderId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const o = await loadOrder(tx, ctx, orderId);
    const [org, tax, branch, cashier] = await inSequence([
      tx.organization.findUniqueOrThrow({
        where: { id: ctx.organizationId },
        select: { name: true },
      }),
      // The receipt shows the VAT number of the company that sold (ADR-084).
      tx.company.findFirst({
        where: {
          organizationId: ctx.organizationId,
          ...(o.companyId ? { id: o.companyId } : { isDefault: true }),
        },
        select: { vatRegistered: true, vatNumber: true },
      }),
      tx.branch.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, id: o.branchId },
        select: { code: true, name: true, timeZone: true },
      }),
      tx.user.findUnique({ where: { id: o.cashierUserId }, select: { name: true } }),
    ]);
    return {
      ...o,
      organizationName: org.name,
      vatNumber: tax?.vatRegistered ? (tax.vatNumber ?? null) : null,
      branch,
      cashierName: cashier?.name ?? null,
      eInvoice: await receiptQrInTx(tx, ctx, o.id),
      pointsEarned: o.customerId
        ? ((
            await tx.loyaltyEntry.aggregate({
              where: { organizationId: ctx.organizationId, orderId: o.id, kind: "EARN" },
              _sum: { points: true },
            })
          )._sum.points ?? 0)
        : 0,
      can: {
        void:
          o.status === "PAID" &&
          o.shift.status === "OPEN" &&
          dec(o.refundedAmount).isZero() &&
          hasPermission(ctx.grants, "pos.void", site(o)),
        refund:
          o.status === "PAID" &&
          dec(o.refundedAmount).lt(dec(o.grossAmount)) &&
          hasPermission(ctx.grants, "pos.refund", site(o)),
      },
    };
  });
}

/** Post the stock of open shortfalls at a warehouse, where it is now available. */
export async function postShortfalls(ctx: TenantContext, warehouseId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await loadWarehouse(tx, ctx, warehouseId);
    if (
      !hasPermission(ctx.grants, "inventory.adjust", { branchId: wh.branchId, warehouseId: wh.id })
    )
      throw forbidden();
    const open = await tx.posConsumptionShortfall.findMany({
      where: { organizationId: ctx.organizationId, warehouseId: wh.id, status: "OPEN" },
      include: { order: { select: { number: true } } },
      orderBy: { createdAt: "asc" },
    });
    let posted = 0;
    for (const s of open) {
      const plan = await planConsumptionInTx(
        tx,
        ctx,
        wh,
        new Map([[s.productId, dec(s.quantity)]]),
      );
      if (plan.shortages.length > 0) continue;
      const doc = await postConsumptionInTx(
        tx,
        ctx,
        wh,
        plan.picks,
        `POS ${s.order.number} (shortfall)`,
      );
      await tx.posConsumptionShortfall.update({
        where: { id: s.id },
        data: { status: "POSTED", documentId: doc.documentId, resolvedAt: new Date() },
      });
      // The order's cost of sales includes what was posted late.
      await tx.$executeRaw`UPDATE "pos_orders" SET "cost_amount" = "cost_amount" + ${doc.cost.toFixed()}::numeric WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${s.orderId}::uuid`;
      posted += 1;
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "pos_shortfall.posted",
      entityType: "warehouse",
      entityId: wh.id,
      changes: { posted, open: open.length - posted },
    });
    return { posted, remaining: open.length - posted };
  });
}

/** Open shortfalls per warehouse the user may adjust (for "needs attention" and the shortfall page). */
export async function listShortfalls(ctx: TenantContext) {
  const scope = accessibleScope(ctx.grants, "inventory.adjust");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.posConsumptionShortfall.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "OPEN",
        ...(scope.all
          ? {}
          : {
              OR: [
                { warehouseId: { in: scope.warehouseIds } },
                { order: { branchId: { in: scope.branchIds } } },
              ],
            }),
      },
      include: {
        product: { select: { sku: true, nameEn: true, baseUom: { select: { code: true } } } },
        order: { select: { id: true, number: true, orderedAt: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    const warehouses = new Map(
      (
        await tx.warehouse.findMany({
          where: {
            organizationId: ctx.organizationId,
            id: { in: [...new Set(rows.map((r) => r.warehouseId))] },
          },
          select: { id: true, code: true, name: true },
        })
      ).map((w) => [w.id, w]),
    );
    return rows.map((r) => ({ ...r, warehouse: warehouses.get(r.warehouseId)! }));
  });
}

// ─── Cashier screen ───

/**
 * What a branch sells today, per channel, with each item's price, VAT rate and
 * options — for the till and the waiter's check screen (the server still
 * prices every order itself).
 */
export async function sellableMenu(ctx: TenantContext, branchId: string, date: string) {
  const menus = await Promise.all(
    SALES_CHANNELS.map((channel) => menuForBranch(ctx, { branchId, channel, date })),
  );
  const ids = [...new Set(menus.flat().map((i) => i.id))];
  const rates = await withTenantTx(ctx.organizationId, async (tx) => {
    const taxes = await loadTaxContextInTx(tx, ctx, { branchId });
    const rows = await tx.menuItem.findMany({
      where: { organizationId: ctx.organizationId, id: { in: ids } },
      select: { id: true, taxCodeId: true, recipe: { select: { taxCodeId: true } } },
    });
    return new Map(
      rows.map((i) => {
        const r = taxes.resolve(i.taxCodeId ?? i.recipe?.taxCodeId, date);
        // A missing rate is refused at checkout with its reason; the till shows the item.
        return [i.id, r && r.ok ? r.rate.toFixed() : null] as const;
      }),
    );
  });
  return SALES_CHANNELS.map((channel, index) => ({
    channel,
    items: menus[index].map((i) => ({
      id: i.id,
      name: i.name,
      nameAr: i.nameAr,
      category: { id: i.category.id, name: i.category.name, nameAr: i.category.nameAr },
      price: i.price.price.toFixed(),
      includesTax: i.price.includesTax,
      taxRate: rates.get(i.id) ?? null,
      groups: i.modifierGroups.map((m) => ({
        id: m.group.id,
        name: m.group.name,
        nameAr: m.group.nameAr,
        minSelect: m.group.minSelect,
        maxSelect: m.group.maxSelect,
        options: m.group.options.map((o) => ({
          id: o.id,
          name: o.name,
          nameAr: o.nameAr,
          priceDelta: dec(o.priceDelta).toFixed(),
        })),
      })),
    })),
  }));
}

/**
 * What the till needs: the register and its open shift, and per channel the
 * items on sale today with their price, VAT rate and options — so the screen
 * shows the total the server will charge (the server still recomputes it).
 */
export async function tillData(ctx: TenantContext, registerId: string) {
  const reg = await withTenantTx(ctx.organizationId, async (tx) => {
    const r = await loadRegister(tx, ctx, registerId);
    assertPermission(ctx.grants, "pos.sell", site(r));
    const shift = await tx.posShift.findFirst({
      where: { organizationId: ctx.organizationId, registerId: r.id, status: "OPEN" },
      select: { id: true, number: true },
    });
    const promotions = await loadPromotionsInTx(tx, ctx, new Date());
    const loyalty = await loyaltySettingsInTx(tx, ctx);
    return { ...r, shift, promotions, loyalty };
  });
  const timeZone = reg.branch.timeZone ?? ctx.timeZone;
  const date = businessDate(timeZone);
  const channels = await sellableMenu(ctx, reg.branchId, date);
  return {
    register: {
      id: reg.id,
      code: reg.code,
      name: reg.name,
      branchName: reg.branch.name,
      archived: reg.archivedAt !== null,
    },
    shift: reg.shift,
    currency: ctx.baseCurrency,
    date,
    /** When this menu was read; queued orders are priced as of this time (ADR-060). */
    menuAsOf: new Date().toISOString(),
    cashierUserId: ctx.userId,
    channels,
    /** Promotions the server applies (ADR-067), evaluated on the till at the branch's time. */
    timeZone,
    promotions: reg.promotions.map(promotionForClient),
    canDiscount: hasPermission(ctx.grants, "pos.discount", site(reg)),
    /** Loyalty points (ADR-068), when the organization uses them. */
    loyalty: reg.loyalty?.enabled
      ? {
          pointValue: reg.loyalty.pointValue.toFixed(),
          minRedeemPoints: reg.loyalty.minRedeemPoints,
        }
      : null,
  };
}

/** A coupon the cashier typed, checked for today at the register's branch (ADR-067). */
export async function couponForRegister(ctx: TenantContext, registerId: string, code: unknown) {
  const reg = await withTenantTx(ctx.organizationId, (tx) => loadRegister(tx, ctx, registerId));
  assertPermission(ctx.grants, "pos.sell", site(reg));
  return lookupCoupon(ctx, code, businessDate(reg.branch.timeZone ?? ctx.timeZone));
}

export type TillData = Awaited<ReturnType<typeof tillData>>;

/** A register with its open shift (and its running totals) and recent shifts. */
export async function getRegister(ctx: TenantContext, registerId: string) {
  const r = await withTenantTx(ctx.organizationId, async (tx) => {
    const reg = await loadRegister(tx, ctx, registerId);
    const shifts = await tx.posShift.findMany({
      where: { organizationId: ctx.organizationId, registerId: reg.id },
      orderBy: { openedAt: "desc" },
      take: 20,
      select: {
        id: true,
        number: true,
        status: true,
        openedAt: true,
        closedAt: true,
        cashDifference: true,
      },
    });
    const warehouse = await tx.warehouse.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: reg.warehouseId },
      select: { code: true, name: true },
    });
    return { ...reg, warehouse, shifts };
  });
  const open = r.shifts.find((s) => s.status === "OPEN");
  return {
    ...r,
    openShift: open ? await getShift(ctx, open.id) : null,
    can: { sell: hasPermission(ctx.grants, "pos.sell", site(r)) },
  };
}

/** Branches and their active warehouses for creating a register. */
export async function registerFormOptions(ctx: TenantContext) {
  assertPermission(ctx.grants, "pos.manage");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.branch.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        warehouses: {
          where: { archivedAt: null },
          select: { id: true, code: true, name: true },
          orderBy: { code: "asc" },
        },
      },
      orderBy: { code: "asc" },
    }),
  );
}

/** Registers of a branch with an open shift where this user may pay a refund out. */
export async function refundRegisters(ctx: TenantContext, branchId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.posRegister.findMany({
      where: {
        organizationId: ctx.organizationId,
        branchId,
        archivedAt: null,
        shifts: { some: { status: "OPEN" } },
      },
      select: { id: true, code: true, name: true, branchId: true, warehouseId: true },
      orderBy: { code: "asc" },
    });
    return rows.filter((r) => hasPermission(ctx.grants, "pos.refund", site(r)));
  });
}
