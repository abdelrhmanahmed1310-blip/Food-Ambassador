import "server-only";
import { z } from "zod";
import { decimalString, Decimal, roundMoney } from "@/lib/decimal";
import { isCalendarDate } from "@/lib/dates";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { zonedInstant } from "@/modules/pos/pickup-rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound } from "@/server/errors";
import {
  matchLine,
  parsePayoutCsv,
  payoutTotals,
  SETTLES,
  type KnownOrder,
  type PayoutLineInput,
  type PayoutRowError,
} from "./payout-rules";

/**
 * Delivery platform payouts (DECISIONS.md ADR-075). Finance imports a
 * platform's settlement statement; each line is matched to the delivery
 * order we received, differences are shown, and orders the platform has not
 * paid for are listed. Confirming fixes the payout and marks its orders paid,
 * so no order is counted as paid twice.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const dateSchema = z.string().trim().refine(isCalendarDate, { error: "invalidDate" });

function canView(ctx: TenantContext) {
  return hasPermission(ctx.grants, "payments.manage") || hasPermission(ctx.grants, "invoices.view");
}
function assertView(ctx: TenantContext) {
  if (!canView(ctx)) throw forbidden();
}

const payoutSchema = z
  .object({
    connectorId: uuidSchema,
    reference: requiredText(100),
    periodFrom: dateSchema,
    periodTo: dateSchema,
    paidOn: z.union([z.literal(""), dateSchema]).optional(),
    receivedAmount: z
      .union([z.literal(""), decimalString({ maxScale: 4, min: "0", max: "1000000000000" })])
      .optional(),
    note: optionalText(500),
  })
  .refine((v) => v.periodFrom <= v.periodTo, { path: ["periodTo"], error: "invalidPeriod" });

async function loadConnector(tx: Tx, ctx: TenantContext, connectorId: string) {
  const c = await tx.connector.findFirst({
    where: { organizationId: ctx.organizationId, id: connectorId, kind: "DELIVERY_ORDERS" },
    select: { id: true, name: true },
  });
  if (!c) throw notFound("Connector");
  return c;
}

/** Orders of the connector by the platform's id, and whether another confirmed payout settled them. */
async function knownOrders(
  tx: Tx,
  ctx: TenantContext,
  connectorId: string,
  ids: string[],
  payoutId?: string,
) {
  const rows = await tx.deliveryOrder.findMany({
    where: { organizationId: ctx.organizationId, connectorId, externalId: { in: ids } },
    select: {
      id: true,
      externalId: true,
      status: true,
      total: true,
      payoutLines: { where: { settled: true }, select: { payoutId: true } },
    },
  });
  return new Map(
    rows.map((o) => [
      o.externalId,
      {
        id: o.id,
        known: {
          status: o.status,
          total: dec(o.total),
          settledElsewhere: o.payoutLines.some((l) => l.payoutId !== payoutId),
        } satisfies KnownOrder,
      },
    ]),
  );
}

export type ImportPayoutResult =
  { ok: true; payoutId: string; lines: number } | { ok: false; errors: PayoutRowError[] };

/** Import a settlement statement as a draft payout. */
export async function importDeliveryPayout(
  ctx: TenantContext,
  rawInput: unknown,
  file: { fileName?: string; text: string },
): Promise<ImportPayoutResult> {
  assertPermission(ctx.grants, "payments.manage");
  const v = payoutSchema.parse(rawInput);
  const parsed = parsePayoutCsv(file.text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const connector = await loadConnector(tx, ctx, v.connectorId);
      const ids = parsed.lines.flatMap((l) => (l.externalId ? [l.externalId] : []));
      const orders = await knownOrders(tx, ctx, connector.id, ids);
      const totals = payoutTotals(parsed.lines);
      const payout = await tx.deliveryPayout.create({
        data: {
          organizationId: ctx.organizationId,
          connectorId: connector.id,
          reference: v.reference,
          periodFrom: new Date(`${v.periodFrom}T00:00:00Z`),
          periodTo: new Date(`${v.periodTo}T00:00:00Z`),
          paidOn: v.paidOn ? new Date(`${v.paidOn}T00:00:00Z`) : null,
          gross: totals.gross.toString(),
          commission: totals.commission.toString(),
          fees: totals.fees.toString(),
          vatOnFees: totals.vatOnFees.toString(),
          net: totals.net.toString(),
          receivedAmount: v.receivedAmount ? v.receivedAmount : null,
          fileName: file.fileName?.slice(0, 200) ?? null,
          note: v.note ?? null,
          createdByUserId: ctx.userId,
          lines: { create: parsed.lines.map((l) => lineData(l, orders)) },
        },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "delivery_payout.imported",
        entityType: "delivery_payout",
        entityId: payout.id,
        changes: {
          connectorId: connector.id,
          reference: v.reference,
          lines: parsed.lines.length,
          net: totals.net.toString(),
        },
      });
      return { ok: true as const, payoutId: payout.id, lines: parsed.lines.length };
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw businessRuleViolation(
        "DELIVERY_PAYOUT_DUPLICATE",
        "This statement was already imported",
      );
    throw error;
  }
}

// organization_id comes from the payout (composite relation).
function lineData(l: PayoutLineInput, orders: Map<string, { id: string; known: KnownOrder }>) {
  const o = l.externalId ? orders.get(l.externalId) : undefined;
  return {
    lineNo: l.lineNo,
    externalId: l.externalId,
    description: l.description,
    gross: roundMoney(l.gross).toString(),
    commission: roundMoney(l.commission).toString(),
    fees: roundMoney(l.fees).toString(),
    vatOnFees: roundMoney(l.vatOnFees).toString(),
    net: roundMoney(l.net).toString(),
    match: matchLine(l, o?.known),
    deliveryOrderId: o?.id ?? null,
    recordedTotal: o ? o.known.total.toString() : null,
  };
}

export async function listDeliveryPayouts(ctx: TenantContext) {
  assertView(ctx);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.deliveryPayout.findMany({
      where: { organizationId: ctx.organizationId },
      include: { connector: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  );
}

/** The payout with its lines, and the accepted orders of its period it does not pay for. */
export async function getDeliveryPayout(ctx: TenantContext, id: string) {
  assertView(ctx);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Delivery payout");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const payout = await tx.deliveryPayout.findFirst({
      where: { organizationId: ctx.organizationId, id: parsed.data },
      include: {
        connector: { select: { id: true, name: true } },
        lines: {
          orderBy: { lineNo: "asc" },
          include: {
            deliveryOrder: { select: { posOrder: { select: { id: true, number: true } } } },
          },
        },
      },
    });
    if (!payout) throw notFound("Delivery payout");
    const from = zonedInstant(payout.periodFrom.toISOString().slice(0, 10), "00:00", ctx.timeZone);
    const toDay = new Date(payout.periodTo.getTime() + 86_400_000).toISOString().slice(0, 10);
    const to = zonedInstant(toDay, "00:00", ctx.timeZone);
    const onThis = new Set(
      payout.lines.flatMap((l) => (l.deliveryOrderId ? [l.deliveryOrderId] : [])),
    );
    const unpaid = (
      await tx.deliveryOrder.findMany({
        where: {
          organizationId: ctx.organizationId,
          connectorId: payout.connectorId,
          status: "ACCEPTED",
          placedAt: { gte: from, lt: to },
          payoutLines: { none: { settled: true } },
        },
        select: { id: true, externalId: true, displayCode: true, total: true, placedAt: true },
        orderBy: { placedAt: "asc" },
        take: 500,
      })
    ).filter((o) => !onThis.has(o.id));
    const totals = payoutTotals(
      payout.lines.map((l) => ({
        gross: dec(l.gross),
        commission: dec(l.commission),
        fees: dec(l.fees),
        vatOnFees: dec(l.vatOnFees),
        net: dec(l.net),
      })),
    );
    const exceptions = payout.lines.filter((l) => l.match !== "MATCHED").length;
    return {
      payout,
      unpaid,
      effectiveRate: totals.effectiveRate,
      exceptions,
      unpaidTotal: roundMoney(unpaid.reduce((s, o) => s.plus(dec(o.total)), new Decimal(0))),
      bankDifference:
        payout.receivedAmount === null
          ? null
          : roundMoney(dec(payout.receivedAmount).minus(dec(payout.net))),
    };
  });
}

async function lockDraft(tx: Tx, ctx: TenantContext, id: string) {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Delivery payout");
  await tx.$queryRaw`SELECT 1 FROM "delivery_payouts" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${parsed.data}::uuid FOR UPDATE`;
  const p = await tx.deliveryPayout.findFirst({
    where: { organizationId: ctx.organizationId, id: parsed.data },
    include: { lines: true },
  });
  if (!p) throw notFound("Delivery payout");
  if (p.status !== "DRAFT")
    throw businessRuleViolation("DELIVERY_PAYOUT_CONFIRMED", "This payout is already confirmed");
  return p;
}

/**
 * Confirm a payout: the lines are matched again (another payout may have been
 * confirmed since the import), the orders it pays for are marked paid, and
 * the payout is fixed.
 */
export async function confirmDeliveryPayout(ctx: TenantContext, id: string) {
  assertPermission(ctx.grants, "payments.manage");
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const p = await lockDraft(tx, ctx, id);
      const ids = p.lines.flatMap((l) => (l.externalId ? [l.externalId] : []));
      const orders = await knownOrders(tx, ctx, p.connectorId, ids, p.id);
      let settled = 0;
      for (const l of p.lines) {
        const o = l.externalId ? orders.get(l.externalId) : undefined;
        const match = matchLine({ externalId: l.externalId, gross: dec(l.gross) }, o?.known);
        const settles = SETTLES.has(match);
        if (settles) settled += 1;
        await tx.deliveryPayoutLine.update({
          where: { id: l.id },
          data: {
            match,
            deliveryOrderId: o?.id ?? null,
            recordedTotal: o ? o.known.total.toString() : null,
            settled: settles,
          },
        });
      }
      await tx.deliveryPayout.update({
        where: { id: p.id },
        data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedByUserId: ctx.userId },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "delivery_payout.confirmed",
        entityType: "delivery_payout",
        entityId: p.id,
        changes: { reference: p.reference, settledOrders: settled, net: p.net.toString() },
      });
      return { settled };
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw businessRuleViolation(
        "DELIVERY_PAYOUT_ALREADY_PAID",
        "An order on this payout was paid by another payout",
      );
    throw error;
  }
}

/** Delete a draft payout (a wrong file); confirmed payouts are kept. */
export async function deleteDeliveryPayout(ctx: TenantContext, id: string) {
  assertPermission(ctx.grants, "payments.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const p = await lockDraft(tx, ctx, id);
    await tx.deliveryPayout.delete({ where: { id: p.id } });
    await recordAudit(tx, actorOf(ctx), {
      action: "delivery_payout.deleted",
      entityType: "delivery_payout",
      entityId: p.id,
      changes: { reference: p.reference },
    });
  });
}

/** Delivery connectors to import statements for. */
export async function payoutConnectors(ctx: TenantContext) {
  assertPermission(ctx.grants, "payments.manage");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.connector.findMany({
      where: { organizationId: ctx.organizationId, kind: "DELIVERY_ORDERS" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );
}
