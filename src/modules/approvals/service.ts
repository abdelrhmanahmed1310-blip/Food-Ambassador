import "server-only";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { validationFailed } from "@/server/errors";
import { LAYER_POSITIONS, type ApprovalDocument, type ApprovalLayer } from "./rules";

/** The organization's layers for one document type (ADR-049); none = no approval needed. */
export async function loadLayers(
  tx: Tx,
  ctx: TenantContext,
  document: ApprovalDocument,
): Promise<ApprovalLayer[]> {
  const rows = await tx.approvalLayer.findMany({
    where: { organizationId: ctx.organizationId, document },
    orderBy: { position: "asc" },
  });
  return rows.map((r) => ({
    position: r.position,
    aboveAmount: new Decimal(r.aboveAmount.toString()),
  }));
}

export async function getApprovalMatrix(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, async (tx) => ({
    PURCHASE_ORDER: await loadLayers(tx, ctx, "PURCHASE_ORDER"),
    STOCK_COUNT: await loadLayers(tx, ctx, "STOCK_COUNT"),
  }));
}

const amount = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .pipe(decimalString({ maxScale: 4, min: "0" }).optional());

/** Form fields `layer1`…`layer4`: the amount above which the layer is required; empty = not used. */
const matrixSchema = z.object({ layer1: amount, layer2: amount, layer3: amount, layer4: amount });

export async function updateApprovalMatrix(
  ctx: TenantContext,
  document: ApprovalDocument,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = matrixSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const layers = LAYER_POSITIONS.flatMap((position) => {
    const v = parsed.data[`layer${position}`];
    return v === undefined ? [] : [{ position, aboveAmount: v }];
  });
  await withTenantTx(ctx.organizationId, async (tx) => {
    const before = await loadLayers(tx, ctx, document);
    await tx.approvalLayer.deleteMany({ where: { organizationId: ctx.organizationId, document } });
    if (layers.length > 0)
      await tx.approvalLayer.createMany({
        data: layers.map((l) => ({
          organizationId: ctx.organizationId,
          document,
          position: l.position,
          aboveAmount: l.aboveAmount,
        })),
      });
    await recordAudit(tx, actorOf(ctx), {
      action: "approval_matrix.updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: {
        document,
        from: before.map((l) => ({ position: l.position, above: l.aboveAmount.toFixed() })),
        to: layers.map((l) => ({ position: l.position, above: l.aboveAmount })),
      },
    });
  });
}
