import "server-only";
import { createHash } from "node:crypto";
import { toDecimal } from "@/lib/decimal";
import { parseCsvRecords, toCsv } from "@/lib/csv";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, loadUnits } from "@/modules/catalog/service";
import { productSchema } from "@/modules/catalog/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx } from "@/server/db/transactions";
import { AppError, conflict } from "@/server/errors";
import {
  assertActive,
  assertWarehousePermission,
  loadWarehouse,
  resolveInboundLot,
  toBase,
  todayFor,
} from "./context";
import { postDocument, type PostingLine } from "./posting";
import { listBalances, type BalanceFilters } from "./queries";
import { openingBalanceSchema } from "./schemas";

export const MAX_IMPORT_ROWS = 2000;

export interface RowError {
  row: number; // 1-based data row (the header is row 0)
  column: string;
  message: string; // translation key under validation.* or rules.*
}

export interface ImportResult {
  ok: boolean;
  imported: number;
  errors: RowError[];
  documents?: string[];
}

function fileTooLarge(count: number): ImportResult {
  return {
    ok: false,
    imported: 0,
    errors: [{ row: 0, column: "", message: count === 0 ? "csvEmpty" : "csvTooManyRows" }],
  };
}

function missingColumns(headers: string[], required: string[]): ImportResult | null {
  const missing = required.filter((c) => !headers.includes(c));
  return missing.length
    ? {
        ok: false,
        imported: 0,
        errors: missing.map((column) => ({ row: 0, column, message: "csvMissingColumn" })),
      }
    : null;
}

function parse(text: string) {
  try {
    return parseCsvRecords(text);
  } catch {
    return null;
  }
}

/** Map an AppError (validation or rule) to row errors. */
function rowErrors(row: number, error: unknown, columnFor: (path: string) => string): RowError[] {
  if (error instanceof AppError) {
    const d = error.details ?? {};
    if (error.code === "VALIDATION_FAILED") {
      return ((d.issues as Array<{ path: string; message: string }>) ?? []).map((i) => ({
        row,
        column: columnFor(i.path),
        message: i.message,
      }));
    }
    if (typeof d.rule === "string") return [{ row, column: "", message: d.rule }];
    if (typeof d.reason === "string")
      return [
        { row, column: typeof d.field === "string" ? columnFor(d.field) : "", message: d.reason },
      ];
    return [{ row, column: "", message: error.code }];
  }
  throw error;
}

// ─── Products ───

const PRODUCT_COLUMNS = {
  sku: "sku",
  nameEn: "name_en",
  nameAr: "name_ar",
  type: "type",
  baseUomId: "base_unit",
  lotTracking: "lot_tracking",
  shelfLifeDays: "shelf_life_days",
  storageRequirement: "storage",
} as const;

/**
 * Import new products. All rows are validated first; nothing is written
 * unless every row is valid (all-or-nothing). Existing SKUs are errors, not
 * updates, so an import can never silently change master data.
 */
export async function importProducts(ctx: TenantContext, text: string): Promise<ImportResult> {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = parse(text);
  if (!parsed)
    return { ok: false, imported: 0, errors: [{ row: 0, column: "", message: "csvMalformed" }] };
  const { headers, records } = parsed;
  if (records.length === 0 || records.length > MAX_IMPORT_ROWS) return fileTooLarge(records.length);
  const missing = missingColumns(headers, ["sku", "name_en", "type", "base_unit"]);
  if (missing) return missing;

  return withTenantTx(ctx.organizationId, async (tx) => {
    const units = new Map((await loadUnits(tx, ctx)).map((u) => [u.code, u.id]));
    const existing = new Set(
      (
        await tx.product.findMany({
          where: { organizationId: ctx.organizationId },
          select: { sku: true },
        })
      ).map((p) => p.sku),
    );
    const errors: RowError[] = [];
    const seen = new Set<string>();
    const valid: Array<ReturnType<typeof productSchema.parse>> = [];
    const columnFor = (path: string) =>
      PRODUCT_COLUMNS[path as keyof typeof PRODUCT_COLUMNS] ?? path;

    records.forEach((r, i) => {
      const row = i + 1;
      const unitId = units.get((r.base_unit ?? "").toLowerCase());
      const result = productSchema.safeParse({
        sku: r.sku,
        nameEn: r.name_en,
        nameAr: r.name_ar,
        type: (r.type ?? "").toUpperCase(),
        baseUomId: unitId ?? "",
        lotTracking: r.lot_tracking ? r.lot_tracking.toUpperCase() : undefined,
        shelfLifeDays: r.shelf_life_days,
        storageRequirement: r.storage ? r.storage.toUpperCase() : undefined,
      });
      if (!unitId) errors.push({ row, column: "base_unit", message: "unknownUnit" });
      if (!result.success) {
        for (const issue of result.error.issues) {
          if (issue.path[0] === "baseUomId" && !unitId) continue;
          errors.push({ row, column: columnFor(String(issue.path[0])), message: issue.message });
        }
        return;
      }
      if (existing.has(result.data.sku)) errors.push({ row, column: "sku", message: "skuTaken" });
      else if (seen.has(result.data.sku))
        errors.push({ row, column: "sku", message: "skuDuplicateInFile" });
      seen.add(result.data.sku);
      if (unitId) valid.push(result.data);
    });
    if (errors.length > 0) return { ok: false, imported: 0, errors };

    await tx.product.createMany({
      data: valid.map((p) => ({
        ...p,
        organizationId: ctx.organizationId,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })),
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "product.imported",
      entityType: "product",
      changes: { count: valid.length },
    });
    return { ok: true, imported: valid.length, errors: [] };
  });
}

// ─── Opening balances ───

const OPENING_COLUMNS: Record<string, string> = {
  warehouseId: "warehouse_code",
  locationId: "location_code",
  productId: "sku",
  lotCode: "lot_code",
  expiresOn: "expires_on",
  quantity: "quantity",
  uomId: "unit",
  unitCost: "unit_cost",
};

/**
 * Import opening balances: one OPENING_BALANCE document per warehouse, all
 * in one transaction (all-or-nothing). Posting keys include a hash of the
 * file, so importing the same file twice is rejected instead of doubling stock.
 */
export async function importOpeningBalances(
  ctx: TenantContext,
  text: string,
): Promise<ImportResult> {
  const parsed = parse(text);
  if (!parsed)
    return { ok: false, imported: 0, errors: [{ row: 0, column: "", message: "csvMalformed" }] };
  const { headers, records } = parsed;
  if (records.length === 0 || records.length > MAX_IMPORT_ROWS) return fileTooLarge(records.length);
  const missing = missingColumns(headers, ["warehouse_code", "sku", "quantity", "unit"]);
  if (missing) return missing;
  const fileHash = createHash("sha256").update(text).digest("hex").slice(0, 32);
  const columnFor = (path: string) => OPENING_COLUMNS[path] ?? path;

  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const units = new Map((await loadUnits(tx, ctx)).map((u) => [u.code, u.id]));
      const warehouses = new Map(
        (
          await tx.warehouse.findMany({
            where: { organizationId: ctx.organizationId },
            select: { id: true, code: true },
          })
        ).map((w) => [w.code, w.id]),
      );
      const products = new Map(
        (
          await tx.product.findMany({
            where: { organizationId: ctx.organizationId },
            select: { id: true, sku: true },
          })
        ).map((p) => [p.sku, p.id]),
      );
      const errors: RowError[] = [];
      const byWarehouse = new Map<string, PostingLine[]>();
      const warehouseInfo = new Map<string, Awaited<ReturnType<typeof loadWarehouse>>>();

      for (const [i, r] of records.entries()) {
        const row = i + 1;
        const warehouseId = warehouses.get((r.warehouse_code ?? "").toUpperCase());
        const productId = products.get((r.sku ?? "").toUpperCase());
        const uomId = units.get((r.unit ?? "").toLowerCase());
        if (!warehouseId)
          errors.push({ row, column: "warehouse_code", message: "unknownWarehouse" });
        if (!productId) errors.push({ row, column: "sku", message: "unknownSku" });
        if (!uomId) errors.push({ row, column: "unit", message: "unknownUnit" });
        if (!warehouseId || !productId || !uomId) continue;
        try {
          let wh = warehouseInfo.get(warehouseId);
          if (!wh) {
            wh = await loadWarehouse(tx, ctx, warehouseId);
            assertWarehousePermission(ctx, "inventory.adjust", wh);
            assertActive(wh);
            warehouseInfo.set(warehouseId, wh);
          }
          let locationId: string | undefined;
          if (r.location_code) {
            const loc = await tx.storageLocation.findFirst({
              where: {
                organizationId: ctx.organizationId,
                warehouseId,
                code: r.location_code.toUpperCase(),
                archivedAt: null,
              },
              select: { id: true },
            });
            if (!loc) {
              errors.push({ row, column: "location_code", message: "unknownLocation" });
              continue;
            }
            locationId = loc.id;
          }
          const input = openingBalanceSchema.safeParse({
            warehouseId,
            locationId,
            productId,
            lotCode: r.lot_code,
            expiresOn: r.expires_on,
            quantity: r.quantity,
            uomId,
            unitCost: r.unit_cost,
          });
          if (!input.success) {
            errors.push(
              ...input.error.issues.map((iss) => ({
                row,
                column: columnFor(String(iss.path[0])),
                message: iss.message,
              })),
            );
            continue;
          }
          const product = await findProduct(tx, ctx, productId);
          const other = await tx.inventoryLedgerEntry.count({
            where: {
              organizationId: ctx.organizationId,
              productId,
              warehouseId,
              movementType: { notIn: ["OPENING_BALANCE", "REVERSAL"] },
            },
          });
          if (other > 0) {
            errors.push({ row, column: "sku", message: "OPENING_BALANCE_AFTER_MOVEMENTS" });
            continue;
          }
          const lot = await resolveInboundLot(tx, ctx, product, input.data);
          const quantity = await toBase(tx, ctx, product, uomId, input.data.quantity);
          const cost =
            input.data.unitCost === undefined
              ? null
              : toDecimal(input.data.unitCost)
                  .times(toDecimal(input.data.quantity))
                  .dividedBy(quantity)
                  .toDecimalPlaces(6);
          const lines = byWarehouse.get(warehouseId) ?? [];
          lines.push({
            movementType: "OPENING_BALANCE",
            warehouseId,
            locationId: locationId ?? null,
            productId,
            lotId: lot?.id ?? null,
            stockStatus: "AVAILABLE",
            quantityDelta: quantity,
            enteredQuantity: toDecimal(input.data.quantity),
            enteredUomId: uomId,
            unitCost: cost,
            postingKey: `opening-import:${fileHash}:${row}`,
            note: `CSV row ${row}`,
          });
          byWarehouse.set(warehouseId, lines);
        } catch (error) {
          errors.push(...rowErrors(row, error, columnFor));
        }
      }
      if (errors.length > 0) {
        // Abort the transaction so lots created while validating are rolled back too.
        throw new ImportRejected(errors);
      }
      const documents: string[] = [];
      for (const [warehouseId, lines] of byWarehouse) {
        const wh = warehouseInfo.get(warehouseId)!;
        const posted = await postDocument(
          tx,
          ctx,
          { type: "OPENING_BALANCE", warehouseId, note: "CSV import" },
          lines,
          {
            year: Number(todayFor(wh).slice(0, 4)),
            auditChanges: { source: "csv", fileHash },
          },
        );
        documents.push(posted.number);
      }
      return { ok: true, imported: records.length, errors: [], documents };
    });
  } catch (error) {
    if (error instanceof ImportRejected) return { ok: false, imported: 0, errors: error.errors };
    // postDocument reports a duplicate posting key as CONFLICT/alreadyPosted.
    const alreadyPosted =
      error instanceof AppError &&
      error.code === "CONFLICT" &&
      error.details?.reason === "alreadyPosted";
    if (
      alreadyPosted ||
      isUniqueViolation(error, "inventory_ledger_entries_organization_id_posting_key_key")
    ) {
      throw conflict("This file was already imported", { reason: "fileAlreadyImported" });
    }
    throw error;
  }
}

class ImportRejected extends Error {
  constructor(readonly errors: RowError[]) {
    super("Import rejected");
  }
}

// ─── Exports ───

export async function exportBalancesCsv(
  ctx: TenantContext,
  filters: Omit<BalanceFilters, "page">,
): Promise<string> {
  const rows: string[][] = [];
  for (let page = 1; ; page++) {
    const result = await listBalances(ctx, { ...filters, page });
    for (const r of result.items) {
      rows.push([
        r.warehouse.code,
        r.location?.code ?? "",
        r.product.sku,
        r.product.nameEn,
        r.product.nameAr ?? "",
        r.lot?.lotCode ?? "",
        r.lot?.expiresOn ?? "",
        r.stockStatus,
        r.onHand.toFixed(),
        r.available.toFixed(),
        r.product.baseUom,
        r.expiry,
      ]);
    }
    if (page >= result.pageCount) break;
  }
  return toCsv(
    [
      "warehouse_code",
      "location_code",
      "sku",
      "name_en",
      "name_ar",
      "lot_code",
      "expires_on",
      "status",
      "on_hand",
      "available",
      "unit",
      "expiry_state",
    ],
    rows,
  );
}

export const PRODUCT_TEMPLATE = toCsv(
  ["sku", "name_en", "name_ar", "type", "base_unit", "lot_tracking", "shelf_life_days", "storage"],
  [["RICE-5KG", "Basmati rice", "أرز بسمتي", "RAW_MATERIAL", "kg", "NONE", "", "AMBIENT"]],
);

export const OPENING_TEMPLATE = toCsv(
  [
    "warehouse_code",
    "location_code",
    "sku",
    "lot_code",
    "expires_on",
    "quantity",
    "unit",
    "unit_cost",
  ],
  [["MAIN", "", "RICE-5KG", "", "", "25", "kg", "42.50"]],
);
