import "server-only";
import type { TenantContext } from "@/modules/tenancy/context";
import type { Tx } from "@/server/db/transactions";
import { requisitionStatusFromLines } from "./rules";

/**
 * Lock requisition rows in id order. Callers that also lock a purchase order
 * lock the order first (order → requisition), as removeOrderLine does.
 */
export async function lockRequisitions(tx: Tx, ctx: TenantContext, ids: string[]) {
  for (const id of [...new Set(ids)].sort())
    await tx.$queryRaw`
      SELECT "id" FROM "purchase_requisitions"
      WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${id}::uuid
      FOR UPDATE`;
}

/** Recompute the status of submitted / partly / fully ordered requisitions. */
export async function refreshRequisitionStatus(tx: Tx, ctx: TenantContext, requisitionId: string) {
  const req = await tx.purchaseRequisition.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: requisitionId },
    select: { status: true, lines: { select: { purchaseOrderLineId: true } } },
  });
  if (!["SUBMITTED", "PARTIALLY_ORDERED", "ORDERED"].includes(req.status)) return req.status;
  const ordered = req.lines.filter((l) => l.purchaseOrderLineId !== null).length;
  const status = requisitionStatusFromLines(ordered, req.lines.length);
  if (status !== req.status)
    await tx.purchaseRequisition.update({ where: { id: requisitionId }, data: { status } });
  return status;
}

/**
 * Free requisition lines ordered on these purchase order lines (the line is
 * being removed or its order cancelled), so they can be ordered again.
 */
export async function releaseRequisitionLines(
  tx: Tx,
  ctx: TenantContext,
  purchaseOrderLineIds: string[],
) {
  if (purchaseOrderLineIds.length === 0) return;
  const linked = await tx.purchaseRequisitionLine.findMany({
    where: {
      organizationId: ctx.organizationId,
      purchaseOrderLineId: { in: purchaseOrderLineIds },
    },
    select: { id: true, requisitionId: true },
  });
  if (linked.length === 0) return;
  const requisitionIds = linked.map((l) => l.requisitionId);
  await lockRequisitions(tx, ctx, requisitionIds);
  await tx.purchaseRequisitionLine.updateMany({
    where: { organizationId: ctx.organizationId, id: { in: linked.map((l) => l.id) } },
    data: { purchaseOrderLineId: null, orderedAt: null },
  });
  for (const id of [...new Set(requisitionIds)].sort()) await refreshRequisitionStatus(tx, ctx, id);
}
