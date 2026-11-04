import "server-only";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { postInspectionInTx } from "@/modules/inventory/operations";
import { optionalText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { inspectionOutcome } from "./rules";

/**
 * Receiving inspection (DECISIONS.md ADR-101). Receipt lines that went to
 * quarantine — flagged at receipt or for a product inspected on receipt —
 * wait for one inspection: packaging, labelling and condition checks, an
 * optional temperature, and how much is accepted. The accepted part is
 * released to available stock and the rest rejected, through the ledger.
 * Inspections are evidence and never change. Needs
 * `inventory.quarantine.release` at the warehouse.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const yesNo = z.enum(["yes", "no"], { error: "required" }).transform((v) => v === "yes");

const inspectSchema = z.object({
  acceptedQuantity: decimalString({ maxScale: 6, min: "0" }),
  packagingOk: yesNo,
  labellingOk: yesNo,
  conditionOk: yesNo,
  temperatureCelsius: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(decimalString({ maxScale: 1, min: "-80", max: "120", allowNegative: true }).optional()),
  rejectionReason: optionalText(500),
  note: optionalText(1000),
});

function warehouseFilter(ctx: TenantContext) {
  const scope = accessibleScope(ctx.grants, "inventory.quarantine.release");
  if (scope.all) return {};
  return {
    OR: [{ id: { in: scope.warehouseIds } }, { branchId: { in: scope.branchIds } }],
  };
}

const pendingWhere = (ctx: TenantContext) => ({
  organizationId: ctx.organizationId,
  quarantine: true,
  inspection: null,
  receipt: { status: "POSTED" as const, warehouse: warehouseFilter(ctx) },
});

/** Quarantined receipt lines waiting for inspection. */
export async function listPendingInspections(ctx: TenantContext) {
  if (!holdsAnyGrant(ctx.grants, "inventory.quarantine.release")) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.goodsReceiptLine.findMany({
      where: pendingWhere(ctx),
      select: {
        id: true,
        acceptedQuantityBase: true,
        temperatureCelsius: true,
        product: {
          select: {
            sku: true,
            nameEn: true,
            nameAr: true,
            storageRequirement: true,
            baseUom: { select: { code: true } },
          },
        },
        lot: { select: { lotCode: true, expiresOn: true } },
        receipt: {
          select: {
            id: true,
            number: true,
            receivedAt: true,
            supplier: { select: { code: true, name: true } },
            warehouse: { select: { code: true, name: true } },
          },
        },
      },
      orderBy: { receipt: { receivedAt: "asc" } },
      take: 200,
    }),
  );
}

export async function inspectReceiptLine(
  ctx: TenantContext,
  receiptLineId: string,
  rawInput: unknown,
) {
  if (!holdsAnyGrant(ctx.grants, "inventory.quarantine.release")) throw forbidden();
  const parsed = inspectSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  if (!isUuid(receiptLineId)) throw notFound("Receipt line");
  return withTenantTx(ctx.organizationId, async (tx) => {
    // One inspection per line: serialize inspectors on it (the unique index backs this up).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt-inspection:${ctx.organizationId}:${receiptLineId}`}))`;
    const line = await tx.goodsReceiptLine.findFirst({
      where: { organizationId: ctx.organizationId, id: receiptLineId },
      include: {
        inspection: { select: { id: true } },
        receipt: {
          select: { id: true, number: true, status: true, warehouseId: true, locationId: true },
        },
      },
    });
    if (!line) throw notFound("Receipt line");
    if (!line.quarantine || line.receipt.status !== "POSTED")
      throw businessRuleViolation("NOT_AWAITING_INSPECTION", "This line is not in quarantine");
    if (line.inspection)
      throw businessRuleViolation("ALREADY_INSPECTED", "This line was already inspected");
    const outcome = inspectionOutcome({
      total: dec(line.acceptedQuantityBase),
      accepted: input.acceptedQuantity,
      checksPassed: input.packagingOk && input.labellingOk && input.conditionOk,
      hasRejectionReason: !!input.rejectionReason,
      hasNote: !!input.note,
    });
    if (!outcome.ok)
      throw businessRuleViolation(outcome.problem, "The inspection is not complete", {
        field:
          outcome.problem === "ACCEPTED_OUT_OF_RANGE"
            ? "acceptedQuantity"
            : outcome.problem === "REJECTION_REASON_REQUIRED"
              ? "rejectionReason"
              : "note",
        maximum: dec(line.acceptedQuantityBase).toFixed(),
      });
    const posting = await postInspectionInTx(tx, ctx, {
      warehouseId: line.receipt.warehouseId,
      locationId: line.receipt.locationId,
      productId: line.productId,
      lotId: line.lotId,
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      reference: `Inspection of ${line.receipt.number}`,
      note: input.rejectionReason
        ? `Inspection of ${line.receipt.number}: ${input.rejectionReason}`
        : undefined,
    });
    const inspection = await tx.receiptInspection.create({
      data: {
        organizationId: ctx.organizationId,
        receiptLineId: line.id,
        warehouseId: line.receipt.warehouseId,
        productId: line.productId,
        acceptedQuantity: outcome.accepted.toFixed(),
        rejectedQuantity: outcome.rejected.toFixed(),
        decision: outcome.decision,
        temperatureCelsius: input.temperatureCelsius ?? null,
        packagingOk: input.packagingOk,
        labellingOk: input.labellingOk,
        conditionOk: input.conditionOk,
        rejectionReason: outcome.rejected.gt(0) ? (input.rejectionReason ?? null) : null,
        note: input.note ?? null,
        inventoryDocumentId: posting.documentId,
        inspectedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "receipt.inspected",
      entityType: "goods_receipt",
      entityId: line.receipt.id,
      changes: {
        line: line.id,
        decision: outcome.decision,
        accepted: outcome.accepted.toFixed(),
        rejected: outcome.rejected.toFixed(),
        document: posting.number,
      },
    });
    return {
      id: inspection.id,
      decision: outcome.decision,
      accepted: outcome.accepted.toFixed(),
      rejected: outcome.rejected.toFixed(),
      document: posting,
    };
  });
}

/** Recent inspections, newest first. */
export async function listInspections(ctx: TenantContext) {
  if (!holdsAnyGrant(ctx.grants, "inventory.quarantine.release")) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.receiptInspection.findMany({
      where: { organizationId: ctx.organizationId, warehouse: warehouseFilter(ctx) },
      include: {
        document: { select: { id: true, number: true } },
        receiptLine: {
          select: {
            product: {
              select: {
                sku: true,
                nameEn: true,
                nameAr: true,
                baseUom: { select: { code: true } },
              },
            },
            lot: { select: { lotCode: true } },
            receipt: { select: { id: true, number: true } },
          },
        },
      },
      orderBy: { inspectedAt: "desc" },
      take: 100,
    });
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.inspectedByUserId))] } },
      select: { id: true, name: true },
    });
    return rows.map((r) => ({
      ...r,
      inspectedBy: users.find((u) => u.id === r.inspectedByUserId)?.name ?? null,
    }));
  });
}
