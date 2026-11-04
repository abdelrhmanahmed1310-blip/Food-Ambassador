import "server-only";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden } from "@/server/errors";
import { getCount } from "@/modules/inventory/counts";
import { matchesScan, normalizeScan } from "./barcode";
import { getPickList } from "./picking";

/**
 * What a scanned code is (DECISIONS.md ADR-104): a pack unit, pick list,
 * load, storage location, product (by barcode or SKU) or lot — only within
 * what the user may see. Several matches are all returned.
 */
export type ScanMatch =
  | { kind: "PACK_UNIT"; id: string; label: string; pickListId: string; loadId: string | null }
  | { kind: "PICK_LIST"; id: string; label: string }
  | { kind: "LOAD"; id: string; label: string }
  | { kind: "LOCATION"; id: string; label: string; warehouseId: string }
  | { kind: "PRODUCT"; id: string; label: string; via: "BARCODE" | "SKU"; uomCode: string | null }
  | { kind: "LOT"; id: string; label: string };

export async function resolveScan(
  ctx: TenantContext,
  raw: string,
): Promise<{
  code: string;
  matches: ScanMatch[];
}> {
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) throw forbidden();
  const code = normalizeScan(raw);
  if (!code) return { code, matches: [] };
  const upper = code.toUpperCase();
  const org = ctx.organizationId;
  const sees = (w: { id: string; branchId: string }) =>
    hasPermission(ctx.grants, "inventory.view", { branchId: w.branchId, warehouseId: w.id });
  return withTenantTx(org, async (tx) => {
    const matches: ScanMatch[] = [];
    const [unit, list, load, locations, barcodes, product, lots] = await Promise.all([
      tx.packUnit.findFirst({
        where: { organizationId: org, number: upper },
        select: {
          id: true,
          number: true,
          pickList: {
            select: {
              id: true,
              number: true,
              loadId: true,
              warehouse: { select: { id: true, branchId: true } },
            },
          },
        },
      }),
      tx.pickList.findFirst({
        where: { organizationId: org, number: upper },
        select: { id: true, number: true, warehouse: { select: { id: true, branchId: true } } },
      }),
      tx.load.findFirst({
        where: { organizationId: org, number: upper },
        select: {
          id: true,
          number: true,
          vehicleRef: true,
          warehouse: { select: { id: true, branchId: true } },
        },
      }),
      tx.storageLocation.findMany({
        where: { organizationId: org, code: upper, archivedAt: null },
        select: {
          id: true,
          code: true,
          name: true,
          warehouse: { select: { id: true, code: true, branchId: true } },
        },
        take: 10,
      }),
      tx.productBarcode.findMany({
        where: { organizationId: org, barcode: code },
        select: {
          product: { select: { id: true, sku: true, nameEn: true } },
          uom: { select: { code: true } },
        },
        take: 5,
      }),
      tx.product.findFirst({
        where: { organizationId: org, sku: upper },
        select: { id: true, sku: true, nameEn: true },
      }),
      tx.inventoryLot.findMany({
        where: { organizationId: org, lotCode: code },
        select: { id: true, lotCode: true, product: { select: { sku: true } } },
        take: 10,
      }),
    ]);
    if (unit && sees(unit.pickList.warehouse))
      matches.push({
        kind: "PACK_UNIT",
        id: unit.id,
        label: `${unit.number} · ${unit.pickList.number}`,
        pickListId: unit.pickList.id,
        loadId: unit.pickList.loadId,
      });
    if (list && sees(list.warehouse))
      matches.push({ kind: "PICK_LIST", id: list.id, label: list.number });
    if (load && sees(load.warehouse))
      matches.push({ kind: "LOAD", id: load.id, label: `${load.number} · ${load.vehicleRef}` });
    for (const l of locations)
      if (sees(l.warehouse))
        matches.push({
          kind: "LOCATION",
          id: l.id,
          label: `${l.warehouse.code} / ${l.code} — ${l.name}`,
          warehouseId: l.warehouse.id,
        });
    const catalog = hasPermission(ctx.grants, "catalog.view");
    if (catalog) {
      for (const b of barcodes)
        matches.push({
          kind: "PRODUCT",
          id: b.product.id,
          label: `${b.product.sku} — ${b.product.nameEn}`,
          via: "BARCODE",
          uomCode: b.uom?.code ?? null,
        });
      if (product && !barcodes.some((b) => b.product.id === product.id))
        matches.push({
          kind: "PRODUCT",
          id: product.id,
          label: `${product.sku} — ${product.nameEn}`,
          via: "SKU",
          uomCode: null,
        });
    }
    if (hasPermission(ctx.grants, "traceability.view") || catalog)
      for (const l of lots)
        matches.push({ kind: "LOT", id: l.id, label: `${l.lotCode} · ${l.product.sku}` });
    return { code, matches };
  });
}

/** A pick list as the guided picking screen needs it: walk order, codes to expect. */
export async function pickScanPlan(ctx: TenantContext, pickListId: string) {
  const list = await getPickList(ctx, pickListId);
  const barcodes = await withTenantTx(ctx.organizationId, (tx) =>
    tx.productBarcode.findMany({
      where: {
        organizationId: ctx.organizationId,
        productId: { in: [...new Set(list.lines.map((l) => l.productId))] },
      },
      select: { productId: true, barcode: true },
    }),
  );
  return {
    list,
    steps: list.walk.map((l) => ({
      id: l.id,
      locationCode: l.location?.code ?? null,
      sku: l.product.sku,
      name: l.product.nameEn,
      barcodes: barcodes.filter((b) => b.productId === l.productId).map((b) => b.barcode),
      lotCode: l.lot?.lotCode ?? null,
      planned: l.plannedQuantity.toString(),
      unit: l.product.baseUom.code,
    })),
  };
}

/** Lines of an open count matching a scanned product barcode, SKU or lot code. */
export async function countScanLines(ctx: TenantContext, countId: string, code: string) {
  const count = await getCount(ctx, countId);
  const barcodes = await withTenantTx(ctx.organizationId, (tx) =>
    tx.productBarcode.findMany({
      where: {
        organizationId: ctx.organizationId,
        productId: { in: [...new Set(count.lines.map((l) => l.product.id))] },
      },
      select: { productId: true, barcode: true },
    }),
  );
  const lines = code.trim()
    ? count.lines.filter((l) =>
        matchesScan(
          {
            product: {
              id: l.product.id,
              sku: l.product.sku,
              barcodes: barcodes.filter((b) => b.productId === l.product.id).map((b) => b.barcode),
            },
            lot: l.lot,
          },
          code,
        ),
      )
    : [];
  return { count, lines };
}
