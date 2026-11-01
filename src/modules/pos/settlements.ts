import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { addDays } from "@/modules/inventory/rules";
import { requiredText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, validationFailed } from "@/server/errors";
import { matchSettlement, parseSettlementCsv } from "./settlement-rules";

/**
 * Card settlement reconciliation (DECISIONS.md ADR-065), independent of the
 * payment provider: finance imports the acquirer's settlement file and
 * each settled transaction is matched to the POS card payment it pays out.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const MAX_BYTES = 2 * 1024 * 1024;
/** Card payments not paid out after this many days are flagged. */
export const SETTLEMENT_DUE_DAYS = 3;

const importSchema = z.object({ fileName: requiredText(200), text: z.string() });

export async function importSettlement(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "payments.manage");
  const parsed = importSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { fileName, text } = parsed.data;
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw businessRuleViolation("SETTLEMENT_FILE_TOO_LARGE", "The file is larger than 2 MB");
  const { rows, problems } = parseSettlementCsv(text);
  if (problems.length > 0)
    throw businessRuleViolation("SETTLEMENT_FILE_INVALID", "The settlement file has errors", {
      line: problems[0].line,
      column: problems[0].field,
    });
  if (rows.length === 0)
    throw businessRuleViolation("SETTLEMENT_FILE_EMPTY", "The file has no lines");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    if (await tx.cardSettlementBatch.findFirst({ where: { organizationId: org, sha256 } }))
      throw conflict("This file was already imported", { reason: "fileAlreadyImported" });
    const dates = rows.map((r) => r.date).sort();
    const codes = [...new Set(rows.map((r) => r.approvalCode.toUpperCase()))];
    const payments = await tx.posPayment.findMany({
      where: {
        organizationId: org,
        method: "CARD",
        approvalCode: { not: null },
        settlementLines: { none: {} },
        order: {
          businessDate: {
            gte: new Date(`${addDays(dates[0], -2)}T00:00:00Z`),
            lte: new Date(`${addDays(dates.at(-1)!, 2)}T00:00:00Z`),
          },
        },
      },
      select: {
        id: true,
        terminalId: true,
        approvalCode: true,
        amount: true,
        tip: true,
        order: { select: { businessDate: true } },
      },
    });
    const matches = matchSettlement(
      rows,
      payments
        .filter((p) => codes.includes(p.approvalCode!.toUpperCase()))
        .map((p) => ({
          id: p.id,
          date: p.order.businessDate.toISOString().slice(0, 10),
          terminalId: p.terminalId,
          approvalCode: p.approvalCode!,
          charged: dec(p.amount).plus(dec(p.tip)),
        })),
    );
    const batch = await tx.cardSettlementBatch.create({
      data: {
        organizationId: org,
        fileName,
        sha256,
        lineCount: rows.length,
        importedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await tx.cardSettlementLine.createMany({
      data: rows.map((r) => ({
        organizationId: org,
        batchId: batch.id,
        transactionDate: new Date(`${r.date}T00:00:00Z`),
        terminalId: r.terminalId,
        approvalCode: r.approvalCode,
        amount: r.amount.toFixed(),
        fee: r.fee.toFixed(),
        paymentId: matches.get(r.line)!.paymentId,
        match: matches.get(r.line)!.match,
      })),
    });
    const count = (m: string) => [...matches.values()].filter((x) => x.match === m).length;
    const summary = {
      lines: rows.length,
      matched: count("MATCHED"),
      mismatched: count("AMOUNT_MISMATCH"),
      unmatched: count("UNMATCHED"),
    };
    await recordAudit(tx, actorOf(ctx), {
      action: "card_settlement.imported",
      entityType: "card_settlement_batch",
      entityId: batch.id,
      changes: { fileName, ...summary },
    });
    return { id: batch.id, ...summary };
  });
}

const periodSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Card sales against what the acquirer paid out over a period (by business date). */
export async function reconciliation(ctx: TenantContext, rawPeriod: unknown, today: string) {
  assertPermission(ctx.grants, "payments.manage");
  const parsed = periodSchema.safeParse(rawPeriod);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { from, to } = parsed.data;
  const range = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) };
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    const payments = await tx.posPayment.findMany({
      where: { organizationId: org, method: "CARD", order: { businessDate: range } },
      select: {
        id: true,
        amount: true,
        tip: true,
        approvalCode: true,
        cardScheme: true,
        terminalId: true,
        order: { select: { id: true, number: true, businessDate: true, status: true } },
        settlementLines: { select: { amount: true, fee: true, match: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const lines = await tx.cardSettlementLine.findMany({
      where: { organizationId: org, transactionDate: range },
      select: {
        id: true,
        transactionDate: true,
        terminalId: true,
        approvalCode: true,
        amount: true,
        fee: true,
        match: true,
        payment: {
          select: { amount: true, tip: true, order: { select: { id: true, number: true } } },
        },
      },
      orderBy: { transactionDate: "asc" },
    });
    const sum = (xs: Array<{ toString(): string }>) =>
      xs.reduce((a: Decimal, x) => a.plus(dec(x)), new Decimal(0));
    const due = addDays(today, -SETTLEMENT_DUE_DAYS);
    const unsettled = payments
      .filter((p) => p.settlementLines.length === 0 && p.order.status === "PAID")
      .map((p) => ({
        ...p,
        charged: dec(p.amount).plus(dec(p.tip)),
        overdue: p.order.businessDate.toISOString().slice(0, 10) < due,
      }));
    return {
      cardSales: sum(payments.map((p) => dec(p.amount).plus(dec(p.tip)))),
      tips: sum(payments.map((p) => p.tip)),
      settled: sum(lines.filter((l) => l.match !== "UNMATCHED").map((l) => l.amount)),
      fees: sum(lines.map((l) => l.fee)),
      matched: lines.filter((l) => l.match === "MATCHED").length,
      mismatched: lines.filter((l) => l.match === "AMOUNT_MISMATCH"),
      unmatched: lines.filter((l) => l.match === "UNMATCHED"),
      unsettled,
      batches: await tx.cardSettlementBatch.findMany({
        where: { organizationId: org },
        select: { id: true, fileName: true, lineCount: true, importedAt: true },
        orderBy: { importedAt: "desc" },
        take: 10,
      }),
    };
  });
}
