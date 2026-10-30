import "server-only";
import { Decimal, toDecimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { validationFailed } from "@/server/errors";
import { settingsSchema } from "./schemas";

export interface ProcurementRules {
  /** Orders above this total need approval by another user; null = no approval step. */
  approvalThreshold: Decimal | null;
  /** Fraction 0–1. */
  overReceiptTolerance: Decimal;
  /** Fraction 0–1 an invoice price may differ from the order price. */
  invoicePriceTolerance: Decimal;
}

/** Defaults until an organization changes them (ADR-023): no approval step, 0 % tolerance. */
export async function loadRules(tx: Tx, ctx: TenantContext): Promise<ProcurementRules> {
  const row = await tx.procurementSettings.findUnique({
    where: { organizationId: ctx.organizationId },
  });
  return {
    approvalThreshold:
      row?.approvalThreshold == null ? null : new Decimal(row.approvalThreshold.toString()),
    overReceiptTolerance: new Decimal(row?.overReceiptTolerance.toString() ?? "0"),
    invoicePriceTolerance: new Decimal(row?.invoicePriceTolerance.toString() ?? "0"),
  };
}

export async function getProcurementSettings(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, (tx) => loadRules(tx, ctx));
}

export async function updateProcurementSettings(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = settingsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const approvalThreshold = parsed.data.approvalThreshold ?? null;
  const overReceiptTolerance = toDecimal(parsed.data.overReceiptTolerancePercent)
    .dividedBy(100)
    .toFixed();
  const invoicePriceTolerance = toDecimal(parsed.data.invoicePriceTolerancePercent)
    .dividedBy(100)
    .toFixed();
  await withTenantTx(ctx.organizationId, async (tx) => {
    const before = await loadRules(tx, ctx);
    await tx.procurementSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: {
        organizationId: ctx.organizationId,
        approvalThreshold,
        overReceiptTolerance,
        invoicePriceTolerance,
      },
      update: { approvalThreshold, overReceiptTolerance, invoicePriceTolerance },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "procurement.settings_updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: {
        approvalThreshold: {
          from: before.approvalThreshold?.toFixed() ?? null,
          to: approvalThreshold,
        },
        overReceiptTolerance: {
          from: before.overReceiptTolerance.toFixed(),
          to: overReceiptTolerance,
        },
        invoicePriceTolerance: {
          from: before.invoicePriceTolerance.toFixed(),
          to: invoicePriceTolerance,
        },
      },
    });
  });
}
