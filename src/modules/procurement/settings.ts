import "server-only";
import { Decimal, toDecimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { validationFailed } from "@/server/errors";
import { settingsSchema } from "./schemas";

export interface ProcurementRules {
  /** Fraction 0–1. */
  overReceiptTolerance: Decimal;
  /** Fraction 0–1 an invoice price may differ from the order price. */
  invoicePriceTolerance: Decimal;
}

/** Defaults until an organization changes them: 0 % tolerances (ADR-023, Q-09). Approvals: approvals/service (ADR-049). */
export async function loadRules(tx: Tx, ctx: TenantContext): Promise<ProcurementRules> {
  const row = await tx.procurementSettings.findUnique({
    where: { organizationId: ctx.organizationId },
  });
  return {
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
        overReceiptTolerance,
        invoicePriceTolerance,
      },
      update: { overReceiptTolerance, invoicePriceTolerance },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "procurement.settings_updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: {
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
