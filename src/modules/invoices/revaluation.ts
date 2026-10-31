import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { revalue } from "@/modules/fx/rules";
import { rateFor } from "@/modules/fx/service";
import { businessDate } from "@/modules/inventory/rules";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { runIdempotent } from "@/modules/shared/idempotency";
import { idempotencyKeySchema, requiredText } from "@/modules/shared/schemas";
import { currencyDecimals } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { supplierBalances } from "./payables";

/**
 * Period-end revaluation of open foreign-currency payables (DECISIONS.md
 * ADR-052): each supplier's open balance per foreign currency, booked at the
 * documents' own rates, is valued at the rate on `asOf`; the difference is
 * an unrealised exchange gain or loss. Stored as a fixed record and exported
 * as a journal entry on `asOf` reversed the next day, so the next period
 * starts from the booked values again.
 */

const asOfSchema = z.object({
  asOf: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  idempotencyKey: idempotencyKeySchema,
});

/** What a revaluation on `asOf` would contain (needs a usable rate per currency). */
async function computeLines(ctx: TenantContext, tx: Tx, asOf: string) {
  const balances = await supplierBalances(ctx, asOf);
  const decimals = currencyDecimals(ctx.baseCurrency);
  const lines = [];
  for (const r of balances.rows) {
    if (r.currency === ctx.baseCurrency || r.balance.isZero()) continue;
    const fx = await rateFor(tx, ctx, r.currency, asOf);
    const { revaluedBase, differenceBase } = revalue(r.balance, r.balanceBase, fx.rate, decimals);
    lines.push({
      supplier: r.supplier,
      currency: r.currency,
      openAmount: r.balance,
      bookedBase: r.balanceBase,
      rate: fx.rate,
      rateDate: fx.rateDate,
      revaluedBase,
      differenceBase,
    });
  }
  return lines;
}

export async function previewRevaluation(ctx: TenantContext, asOf: string) {
  assertPermission(ctx.grants, "fx.manage");
  if (!isCalendarDate(asOf)) throw validationFailed(new z.ZodError([]));
  return withTenantTx(ctx.organizationId, async (tx) => {
    const lines = await computeLines(ctx, tx, asOf);
    return {
      asOf,
      lines,
      total: lines.reduce((a, l) => a.plus(l.differenceBase), new Decimal(0)),
    };
  });
}

export async function postRevaluation(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "fx.manage");
  const parsed = asOfSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { asOf, idempotencyKey } = parsed.data;
  if (asOf > businessDate(ctx.timeZone))
    throw businessRuleViolation("REVALUATION_IN_FUTURE", "Revalue a date that has passed", {
      field: "asOf",
    });
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "fx_revaluation", input: { asOf } },
      async (tx) => {
        const lines = await computeLines(ctx, tx, asOf);
        if (lines.length === 0)
          throw businessRuleViolation(
            "NOTHING_TO_REVALUE",
            "No open foreign-currency balances on this date",
          );
        const total = lines.reduce((a, l) => a.plus(l.differenceBase), new Decimal(0));
        const number = await nextDocumentNumber(
          tx,
          ctx.organizationId,
          "REV",
          Number(asOf.slice(0, 4)),
        );
        const rev = await tx.fxRevaluation.create({
          data: {
            organizationId: ctx.organizationId,
            number,
            asOf: new Date(`${asOf}T00:00:00Z`),
            totalDifferenceBase: total.toFixed(),
            createdByUserId: ctx.userId,
          },
          select: { id: true, number: true },
        });
        await tx.fxRevaluationLine.createMany({
          data: lines.map((l) => ({
            organizationId: ctx.organizationId,
            revaluationId: rev.id,
            supplierId: l.supplier.id,
            currency: l.currency,
            openAmount: l.openAmount.toFixed(),
            bookedBase: l.bookedBase.toFixed(),
            rate: l.rate.toFixed(),
            rateDate: new Date(`${l.rateDate}T00:00:00Z`),
            revaluedBase: l.revaluedBase.toFixed(),
            differenceBase: l.differenceBase.toFixed(),
          })),
        });
        await recordAudit(tx, actorOf(ctx), {
          action: "fx_revaluation.posted",
          entityType: "fx_revaluation",
          entityId: rev.id,
          changes: { number, asOf, lines: lines.length, total: total.toFixed() },
        });
        return rev;
      },
    );
  } catch (error) {
    if (isUniqueViolation(error, "fx_revaluations_as_of"))
      throw conflict("This date is already revalued", {
        reason: "revaluationExists",
        field: "asOf",
      });
    throw error;
  }
}

export async function cancelRevaluation(
  ctx: TenantContext,
  revaluationId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "fx.manage");
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rev = await tx.fxRevaluation.findFirst({
      where: { organizationId: ctx.organizationId, id: revaluationId },
    });
    if (!rev) throw notFound("Revaluation");
    if (rev.cancelledAt) throw businessRuleViolation("REVALUATION_CANCELLED", "Already cancelled");
    await tx.fxRevaluation.update({
      where: { id: rev.id },
      data: {
        cancelledAt: new Date(),
        cancelledByUserId: ctx.userId,
        cancelReason: parsed.data.reason,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "fx_revaluation.cancelled",
      entityType: "fx_revaluation",
      entityId: rev.id,
      changes: { number: rev.number, reason: parsed.data.reason },
    });
  });
}

export async function listRevaluations(ctx: TenantContext) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.fxRevaluation.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ asOf: "desc" }, { createdAt: "desc" }],
      take: 100,
    }),
  );
}

export async function getRevaluation(ctx: TenantContext, revaluationId: string) {
  assertPermission(ctx.grants, "invoices.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rev = await tx.fxRevaluation.findFirst({
      where: { organizationId: ctx.organizationId, id: revaluationId },
      include: {
        lines: {
          include: { supplier: { select: { id: true, code: true, name: true, nameAr: true } } },
          orderBy: { differenceBase: "desc" },
        },
      },
    });
    if (!rev) throw notFound("Revaluation");
    return rev;
  });
}
