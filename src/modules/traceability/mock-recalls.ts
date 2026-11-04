import "server-only";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { openNonConformanceInTx } from "@/modules/foodsafety/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { mockRecallOutcome, type MockRecallProblem } from "./mock-recall-rules";
import { traceLotInTx } from "./trace";

/**
 * Mock recall exercises (DECISIONS.md ADR-100). A timed drill on one lot
 * that never touches stock: starting it copies the lot's book position
 * (received, left the business, stock by place) and starts the clock; the
 * team counts what it physically finds at each place; completing it stops
 * the clock and scores the drill. A drill with problems opens a
 * non-conformance at the branch that ran it. Finished drills are frozen.
 * Running one needs `recalls.manage`; viewing needs `traceability.view`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

const startSchema = z.object({
  branchId: uuidSchema,
  lotId: uuidSchema,
  scenario: requiredText(1000),
  targetMinutes: z
    .string()
    .optional()
    .transform(blank)
    .refine((v) => v === undefined || /^\d{1,5}$/.test(v), { error: "invalidMinutes" })
    .transform((v) => (v === undefined ? null : Number(v)))
    .refine((v) => v === null || (v >= 1 && v <= 10080), { error: "invalidMinutes" }),
});

const completeSchema = z.object({
  counts: z
    .array(
      z.object({
        id: uuidSchema,
        foundQuantity: decimalString({ maxScale: 6, min: "0" }),
        note: optionalText(500),
      }),
    )
    .max(500),
  findings: optionalText(2000),
});

const cancelSchema = z.object({ note: requiredText(1000) });

const PROBLEM_TEXT: Record<MockRecallProblem, string> = {
  TARGET_MISSED: "the target time was missed",
  STOCK_DIFFERENCE: "the stock found differs from the book",
  NOT_ACCOUNTED: "the lot is not fully accounted for",
  TRACE_GAPS: "the trace has gaps",
  ORIGIN_UNKNOWN: "the lot's origin is not recorded",
};

async function lockMockRecall(tx: Tx, ctx: TenantContext, id: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "mock_recalls"
    WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${id}::uuid
    FOR UPDATE`;
  const drill = await tx.mockRecall.findFirst({
    where: { organizationId: ctx.organizationId, id },
    include: { counts: true },
  });
  if (!drill) throw notFound("Mock recall");
  if (drill.status !== "RUNNING")
    throw businessRuleViolation("MOCK_RECALL_FINISHED", "The exercise is already finished", {
      status: drill.status,
    });
  return drill;
}

/** Start the clock: copy the lot's book position. */
export async function startMockRecall(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "recalls.manage");
  const parsed = startSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { organizationId: ctx.organizationId, id: input.branchId, archivedAt: null },
      select: { id: true },
    });
    if (!branch) throw notFound("Branch");
    const trace = await traceLotInTx(tx, ctx, input.lotId);
    const suppliers = new Set(trace.receipts.map((r) => r.receipt.supplier.id));
    const year = Number(businessDate(ctx.timeZone).slice(0, 4));
    const number = await nextDocumentNumber(tx, ctx.organizationId, "MRC", year);
    const book = trace.stock.reduce((a, s) => a.plus(dec(s.onHandQuantity)), new Decimal(0));
    const drill = await tx.mockRecall.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        branchId: branch.id,
        productId: trace.lot.productId,
        lotId: trace.lot.id,
        scenario: input.scenario,
        targetMinutes: input.targetMinutes,
        startedAt: new Date(),
        startedByUserId: ctx.userId,
        receivedQuantity: trace.received.toFixed(),
        exitedQuantity: trace.exited.toFixed(),
        onHandQuantity: book.toFixed(),
        gapCount: trace.gaps.length,
        supplierCount: suppliers.size,
      },
      select: { id: true, number: true },
    });
    if (trace.stock.length > 0)
      await tx.mockRecallCount.createMany({
        data: trace.stock.map((s) => ({
          organizationId: ctx.organizationId,
          mockRecallId: drill.id,
          warehouseId: s.warehouseId,
          locationId: s.locationId,
          stockStatus: s.stockStatus,
          bookQuantity: s.onHandQuantity,
        })),
      });
    await recordAudit(tx, actorOf(ctx), {
      action: "mock_recall.started",
      entityType: "mock_recall",
      entityId: drill.id,
      changes: { number, lotId: trace.lot.id, targetMinutes: input.targetMinutes },
    });
    return drill;
  });
}

/** Stop the clock with what was found at every place, and score the drill. */
export async function completeMockRecall(ctx: TenantContext, id: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recalls.manage");
  const parsed = completeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { counts, findings } = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const drill = await lockMockRecall(tx, ctx, id);
    const given = new Map(counts.map((c) => [c.id, c]));
    if (
      given.size !== counts.length ||
      [...given.keys()].some((k) => !drill.counts.some((c) => c.id === k))
    )
      throw notFound("Mock recall count");
    const missing = drill.counts.filter((c) => !given.has(c.id));
    if (missing.length > 0)
      throw businessRuleViolation("MOCK_RECALL_COUNTS_MISSING", "Count every place first", {
        missing: missing.length,
      });
    for (const c of drill.counts) {
      const g = given.get(c.id)!;
      await tx.mockRecallCount.update({
        where: { id: c.id },
        data: { foundQuantity: g.foundQuantity, note: g.note ?? null },
      });
    }
    const found = counts.reduce((a, c) => a.plus(c.foundQuantity), new Decimal(0));
    const completedAt = new Date();
    const elapsedSeconds = Math.max(
      0,
      Math.floor((completedAt.getTime() - drill.startedAt.getTime()) / 1000),
    );
    const outcome = mockRecallOutcome({
      received: dec(drill.receivedQuantity),
      exited: dec(drill.exitedQuantity),
      book: dec(drill.onHandQuantity),
      found,
      gapCount: drill.gapCount,
      originKnown: drill.supplierCount > 0 || (await originProduced(tx, ctx, drill.lotId)),
      elapsedSeconds,
      targetMinutes: drill.targetMinutes,
    });
    let nc: { id: string; number: string } | null = null;
    if (outcome.problems.length > 0) {
      const lot = await tx.inventoryLot.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, id: drill.lotId },
        select: { lotCode: true, product: { select: { sku: true } } },
      });
      const branch = await tx.branch.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, id: drill.branchId },
        select: { timeZone: true },
      });
      const minutes = Math.floor(elapsedSeconds / 60);
      nc = await openNonConformanceInTx(tx, ctx, {
        branchId: drill.branchId,
        timeZone: branch.timeZone,
        title: `Mock recall ${drill.number} not passed`,
        description:
          `Mock recall ${drill.number} on lot ${lot.lotCode} (${lot.product.sku}): ` +
          `${outcome.problems.map((p) => PROBLEM_TEXT[p]).join("; ")}. ` +
          `Time taken ${minutes} min${drill.targetMinutes ? ` against a target of ${drill.targetMinutes} min` : ""}; ` +
          `found ${found.toFixed()} against a book of ${dec(drill.onHandQuantity).toFixed()}` +
          `${outcome.accountedPercent ? `; ${outcome.accountedPercent.toFixed(2)} % accounted for` : ""}.`,
        severity: "MEDIUM",
        source: "MOCK_RECALL",
      });
    }
    await tx.mockRecall.update({
      where: { id: drill.id },
      data: {
        status: "COMPLETED",
        completedAt,
        completedByUserId: ctx.userId,
        elapsedSeconds,
        foundQuantity: found.toFixed(),
        accountedPercent: outcome.accountedPercent?.toFixed(2) ?? null,
        withinTarget: outcome.withinTarget,
        findings: findings ?? null,
        nonConformanceId: nc?.id ?? null,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "mock_recall.completed",
      entityType: "mock_recall",
      entityId: drill.id,
      changes: {
        number: drill.number,
        elapsedSeconds,
        found: found.toFixed(),
        problems: outcome.problems,
      },
    });
    return {
      elapsedSeconds,
      problems: outcome.problems,
      accountedPercent: outcome.accountedPercent?.toFixed(2) ?? null,
      withinTarget: outcome.withinTarget,
      nonConformance: nc,
    };
  });
}

export async function cancelMockRecall(ctx: TenantContext, id: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recalls.manage");
  const parsed = cancelSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const drill = await lockMockRecall(tx, ctx, id);
    await tx.mockRecall.update({
      where: { id: drill.id },
      data: { status: "CANCELLED", cancelNote: parsed.data.note },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "mock_recall.cancelled",
      entityType: "mock_recall",
      entityId: drill.id,
      changes: { number: drill.number, note: parsed.data.note },
    });
  });
}

export async function listMockRecalls(ctx: TenantContext) {
  assertPermission(ctx.grants, "traceability.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.mockRecall.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        number: true,
        status: true,
        startedAt: true,
        elapsedSeconds: true,
        targetMinutes: true,
        withinTarget: true,
        accountedPercent: true,
        nonConformance: { select: { id: true, number: true } },
        branch: { select: { code: true } },
        lot: {
          select: { lotCode: true, product: { select: { sku: true, nameEn: true, nameAr: true } } },
        },
      },
      orderBy: { startedAt: "desc" },
      take: 200,
    }),
  );
}

export async function getMockRecall(ctx: TenantContext, id: string) {
  assertPermission(ctx.grants, "traceability.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const drill = await tx.mockRecall.findFirst({
      where: { organizationId: ctx.organizationId, id },
      include: {
        branch: { select: { code: true, name: true } },
        lot: {
          select: {
            id: true,
            lotCode: true,
            expiresOn: true,
            product: {
              select: {
                sku: true,
                nameEn: true,
                nameAr: true,
                baseUom: { select: { code: true } },
              },
            },
          },
        },
        nonConformance: { select: { id: true, number: true, status: true } },
        counts: {
          include: {
            warehouse: { select: { code: true, name: true } },
          },
          orderBy: [{ warehouseId: "asc" }, { stockStatus: "asc" }],
        },
      },
    });
    if (!drill) throw notFound("Mock recall");
    const locationIds = drill.counts.flatMap((c) => (c.locationId ? [c.locationId] : []));
    const locations = locationIds.length
      ? await tx.storageLocation.findMany({
          where: { organizationId: ctx.organizationId, id: { in: locationIds } },
          select: { id: true, code: true },
        })
      : [];
    const users = await tx.user.findMany({
      where: {
        id: {
          in: [drill.startedByUserId, drill.completedByUserId].filter((v): v is string => !!v),
        },
      },
      select: { id: true, name: true },
    });
    const name = (uid: string | null) => users.find((u) => u.id === uid)?.name ?? null;
    const outcome =
      drill.status === "COMPLETED"
        ? mockRecallOutcome({
            received: dec(drill.receivedQuantity),
            exited: dec(drill.exitedQuantity),
            book: dec(drill.onHandQuantity),
            found: dec(drill.foundQuantity ?? 0),
            gapCount: drill.gapCount,
            originKnown: drill.supplierCount > 0 || (await originProduced(tx, ctx, drill.lotId)),
            elapsedSeconds: drill.elapsedSeconds ?? 0,
            targetMinutes: drill.targetMinutes,
          })
        : null;
    return {
      ...drill,
      counts: drill.counts.map((c) => ({
        ...c,
        locationCode: locations.find((l) => l.id === c.locationId)?.code ?? null,
      })),
      startedBy: name(drill.startedByUserId),
      completedBy: name(drill.completedByUserId),
      outcome,
    };
  });
}

async function originProduced(tx: Tx, ctx: TenantContext, lotId: string) {
  return (
    (await tx.productionOrder.count({
      where: { organizationId: ctx.organizationId, outputLotId: lotId, documentId: { not: null } },
    })) > 0
  );
}
