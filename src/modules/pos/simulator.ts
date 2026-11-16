import "server-only";
import { accessibleScope, hasPermission } from "@/modules/access/authorize";
import { companyContext } from "@/modules/fx/service";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden, notFound } from "@/server/errors";
import { loadPromotionsInTx, promotionForClient } from "./promotions";
import { sellableMenu } from "./service";

/**
 * The POS simulator (DECISIONS.md ADR-135): the live menu of a branch —
 * prices, options, VAT rates, barcodes, photos, promotions — and its menu
 * boards, for practising and testing sales and screens. Read only: the
 * simulator never writes an order, a payment, stock, a shift or a ZATCA
 * document; its "sales" stay in the browser.
 */

/**
 * Branches the person may simulate: where they sell or manage the point of
 * sale, whether the grant is for the branch or for one of its warehouses.
 */
async function allowedBranches(ctx: TenantContext): Promise<"all" | Set<string>> {
  const scopes = [
    accessibleScope(ctx.grants, "pos.sell"),
    accessibleScope(ctx.grants, "pos.manage"),
  ];
  if (scopes.some((s) => s.all)) return "all";
  const branchIds = new Set<string>();
  const warehouseIds: string[] = [];
  for (const s of scopes)
    if (!s.all) {
      s.branchIds.forEach((b) => branchIds.add(b));
      warehouseIds.push(...s.warehouseIds);
    }
  if (warehouseIds.length) {
    const wh = await withTenantTx(ctx.organizationId, (tx) =>
      tx.warehouse.findMany({
        where: { organizationId: ctx.organizationId, id: { in: warehouseIds } },
        select: { branchId: true },
      }),
    );
    wh.forEach((w) => branchIds.add(w.branchId));
  }
  return branchIds;
}

export async function simulatorBranches(ctx: TenantContext) {
  const allowed = await allowedBranches(ctx);
  if (allowed !== "all" && allowed.size === 0) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(allowed === "all" ? {} : { id: { in: [...allowed] } }),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}

export async function simulatorData(ctx: TenantContext, branchId: string) {
  const allowed = await allowedBranches(ctx);
  if (allowed !== "all" && !allowed.has(branchId)) throw forbidden();
  const base = await withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { organizationId: ctx.organizationId, id: branchId, archivedAt: null },
      select: { id: true, code: true, name: true, timeZone: true },
    });
    if (!branch) throw notFound("Branch");
    const [promotions, company, boards] = await Promise.all([
      loadPromotionsInTx(tx, ctx, new Date()),
      companyContext(tx, ctx, { branchId: branch.id }),
      tx.orderingChannel.findMany({
        where: {
          organizationId: ctx.organizationId,
          branchId: branch.id,
          kind: "BOARD",
          archivedAt: null,
        },
        select: {
          id: true,
          name: true,
          publicToken: true,
          channels: true,
          boardTheme: true,
          boardPageSeconds: true,
        },
        orderBy: { name: "asc" },
      }),
    ]);
    return { branch, promotions, currency: company.currency, boards };
  });
  const timeZone = base.branch.timeZone ?? ctx.timeZone;
  const channels = await sellableMenu(ctx, base.branch.id, businessDate(timeZone));
  return {
    branch: { id: base.branch.id, code: base.branch.code, name: base.branch.name },
    timeZone,
    currency: base.currency,
    channels,
    promotions: base.promotions.map(promotionForClient),
    canDiscount: hasPermission(ctx.grants, "pos.discount", { branchId: base.branch.id }),
    boards: base.boards.map((b) => ({
      id: b.id,
      name: b.name,
      path: `/board/${b.publicToken}`,
      channels: b.channels,
      theme: b.boardTheme as "LIGHT" | "DARK",
      pageSeconds: b.boardPageSeconds,
    })),
  };
}

export type SimulatorData = Awaited<ReturnType<typeof simulatorData>>;
