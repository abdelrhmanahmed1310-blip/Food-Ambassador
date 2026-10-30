import "server-only";
import { Decimal, decimalString, roundMoney, toDecimal } from "@/lib/decimal";
import { parseCsvRecords } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { assertActive, loadWarehouse } from "@/modules/inventory/context";
import { planConsumptionInTx, postConsumptionInTx } from "@/modules/inventory/consumption";
import { reverseDocumentInTx } from "@/modules/inventory/operations";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { loadRecipeStructureInTx } from "@/modules/recipes/costs";
import { taxFromGross, taxFromNet } from "@/modules/tax/rules";
import { loadTaxContextInTx } from "@/modules/tax/service";
import { explodeRecipe } from "@/modules/recipes/explode";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, forbidden, notFound } from "@/server/errors";
import { requiredText } from "@/modules/shared/schemas";
import { z } from "zod";

/**
 * Sales import (DECISIONS.md ADR-036). A CSV of sold items for one
 * warehouse: each row is a dish (recipe code, quantity in portions), a
 * preparation (recipe code, quantity in its yield unit) or a product (SKU,
 * quantity in its base unit). Rows whose external id was already imported
 * are skipped, so re-uploading a file posts nothing twice. All rows are
 * checked first and nothing is posted unless every row — and the stock —
 * is fine.
 */

export const MAX_SALES_ROWS = 5000;
export const SALES_TEMPLATE =
  "date,external_id,item_code,item_type,quantity,net_amount,gross_amount,tax_code,channel\n2026-11-01,T-1001-1,PASTA,RECIPE,2,,276.00,,dine-in\n";

export interface SalesRowError {
  row: number;
  column: string;
  message: string;
  params?: Record<string, string>;
}

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const quantitySchema = decimalString({ maxScale: 6, min: "0.000001" });
const amountSchema = decimalString({ maxScale: 4, allowNegative: true, min: "-1000000000" });

function fail(errors: SalesRowError[]) {
  return { ok: false as const, errors, imported: 0, skipped: 0, importId: null };
}

export async function importSales(
  ctx: TenantContext,
  input: { warehouseId: string; fileName?: string; text: string },
) {
  let records: Array<Record<string, string>>;
  let headers: string[];
  try {
    ({ headers, records } = parseCsvRecords(input.text));
  } catch {
    return fail([{ row: 0, column: "", message: "csvMalformed" }]);
  }
  if (records.length === 0) return fail([{ row: 0, column: "", message: "csvEmpty" }]);
  if (records.length > MAX_SALES_ROWS)
    return fail([{ row: 0, column: "", message: "csvTooManyRows" }]);
  const missing = ["date", "external_id", "item_code", "quantity"].filter(
    (c) => !headers.includes(c),
  );
  if (missing.length)
    return fail(missing.map((column) => ({ row: 0, column, message: "csvMissingColumn" })));

  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertPermission(ctx.grants, "sales.import", { branchId: wh.branchId, warehouseId: wh.id });
      assertActive(wh);
      // One import at a time per organization, so "already imported" is reliable.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sales-import:${ctx.organizationId}`}))`;

      const recipes = new Map(
        (
          await tx.recipe.findMany({
            where: { organizationId: ctx.organizationId },
            select: {
              id: true,
              code: true,
              type: true,
              taxCodeId: true,
              versions: { where: { status: "ACTIVE" }, select: { id: true } },
            },
          })
        ).map((r) => [r.code, r]),
      );
      const products = new Map(
        (
          await tx.product.findMany({
            where: { organizationId: ctx.organizationId },
            select: { id: true, sku: true, archivedAt: true },
          })
        ).map((p) => [p.sku, p]),
      );
      const ids = records.map((r) => (r.external_id ?? "").trim()).filter(Boolean);
      const existing = new Set(
        (
          await tx.salesLine.findMany({
            where: { organizationId: ctx.organizationId, active: true, externalId: { in: ids } },
            select: { externalId: true },
          })
        ).map((l) => l.externalId),
      );

      const tax = await loadTaxContextInTx(tx, ctx);
      const errors: SalesRowError[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      const lines: Array<{
        rowNo: number;
        externalId: string;
        soldOn: string;
        channel: string | null;
        itemType: "RECIPE" | "PRODUCT";
        recipeId: string | null;
        versionId: string | null;
        asPortions: boolean;
        productId: string | null;
        quantity: Decimal;
        netAmount: string | null;
        taxCodeId: string | null;
        taxRate: string | null;
        taxAmount: string | null;
        grossAmount: string | null;
      }> = [];
      for (const [i, r] of records.entries()) {
        const row = i + 1;
        const externalId = (r.external_id ?? "").trim();
        const date = (r.date ?? "").trim();
        const code = (r.item_code ?? "").trim().toUpperCase();
        const type = (r.item_type ?? "").trim().toUpperCase();
        if (!externalId || externalId.length > 100)
          errors.push({ row, column: "external_id", message: "required" });
        else if (seen.has(externalId))
          errors.push({ row, column: "external_id", message: "duplicateInFile" });
        seen.add(externalId);
        const validDate = isCalendarDate(date);
        if (!validDate) errors.push({ row, column: "date", message: "invalidDate" });
        const qty = quantitySchema.safeParse(r.quantity ?? "");
        if (!qty.success)
          errors.push({
            row,
            column: "quantity",
            message: qty.error.issues[0]?.message ?? "invalidDecimal",
          });
        const amount = r.net_amount?.trim() ? amountSchema.safeParse(r.net_amount) : null;
        if (amount && !amount.success)
          errors.push({
            row,
            column: "net_amount",
            message: amount.error.issues[0]?.message ?? "invalidDecimal",
          });
        const gross = r.gross_amount?.trim() ? amountSchema.safeParse(r.gross_amount) : null;
        if (gross && !gross.success)
          errors.push({
            row,
            column: "gross_amount",
            message: gross.error.issues[0]?.message ?? "invalidDecimal",
          });
        if (amount && gross) errors.push({ row, column: "gross_amount", message: "netOrGross" });
        const taxCodeText = (r.tax_code ?? "").trim().toUpperCase();
        const taxCode = taxCodeText ? tax.byCode.get(taxCodeText) : undefined;
        if (taxCodeText && !taxCode)
          errors.push({
            row,
            column: "tax_code",
            message: "unknownTaxCode",
            params: { code: taxCodeText },
          });
        if (type && type !== "RECIPE" && type !== "PRODUCT")
          errors.push({ row, column: "item_type", message: "invalidOption" });
        const recipe = type === "PRODUCT" ? undefined : recipes.get(code);
        const product = type === "RECIPE" ? undefined : products.get(code);
        if (!recipe && !product) {
          errors.push({ row, column: "item_code", message: "unknownItem", params: { code } });
          continue;
        }
        if (recipe && product) {
          errors.push({ row, column: "item_type", message: "ambiguousItem", params: { code } });
          continue;
        }
        if (recipe && recipe.versions.length === 0) {
          errors.push({ row, column: "item_code", message: "NO_ACTIVE_VERSION", params: { code } });
          continue;
        }
        if (product?.archivedAt) {
          errors.push({ row, column: "item_code", message: "PRODUCT_ARCHIVED", params: { code } });
          continue;
        }
        if (existing.has(externalId)) {
          skipped += 1;
          continue;
        }
        if (!qty.success) continue;
        // VAT (ADR-037): the file's code, else the dish's, else the default; rate on the sale date.
        const given = amount?.success ? amount.data : gross?.success ? gross.data : null;
        let taxed: {
          codeId: string | null;
          rate: Decimal | null;
          net: string | null;
          tax: string | null;
          gross: string | null;
        } = {
          codeId: null,
          rate: null,
          net: amount?.success ? amount.data : gross?.success ? gross.data : null,
          tax: null,
          gross: given,
        };
        const resolved =
          given !== null && validDate ? tax.resolve(taxCode?.id ?? recipe?.taxCodeId, date) : null;
        if (resolved && !resolved.ok) {
          errors.push({
            row,
            column: "tax_code",
            message: resolved.problem,
            params: { code: resolved.code },
          });
          continue;
        }
        if (resolved) {
          const split = amount?.success
            ? taxFromNet(toDecimal(amount.data), resolved.rate, ctx.baseCurrency)
            : taxFromGross(toDecimal(given as string), resolved.rate, ctx.baseCurrency);
          taxed = {
            codeId: resolved.codeId,
            rate: resolved.rate,
            net: split.net.toFixed(),
            tax: split.tax.toFixed(),
            gross: split.gross.toFixed(),
          };
        }
        lines.push({
          rowNo: row,
          externalId,
          soldOn: date,
          channel: r.channel?.trim() ? r.channel.trim().slice(0, 40) : null,
          itemType: recipe ? "RECIPE" : "PRODUCT",
          recipeId: recipe?.id ?? null,
          versionId: recipe?.versions[0].id ?? null,
          asPortions: recipe?.type === "DISH",
          productId: product?.id ?? null,
          quantity: toDecimal(qty.data),
          netAmount: taxed.net,
          taxCodeId: taxed.codeId,
          taxRate: taxed.rate?.toFixed() ?? null,
          taxAmount: taxed.tax,
          grossAmount: taxed.gross,
        });
      }
      if (errors.length > 0) return fail(errors);
      if (lines.length === 0)
        return { ok: true as const, errors: [], imported: 0, skipped, importId: null };

      // Explode recipes into product use.
      const structures = await loadRecipeStructureInTx(
        tx,
        ctx,
        lines.flatMap((l) => (l.versionId ? [l.versionId] : [])),
      );
      const usage = new Map<string, Decimal>();
      const add = (id: string, q: Decimal) =>
        usage.set(id, (usage.get(id) ?? new Decimal(0)).plus(q));
      for (const l of lines) {
        if (l.productId) {
          add(l.productId, l.quantity);
          continue;
        }
        const s = structures.get(l.versionId as string)!;
        const e = explodeRecipe(s.root, s.world, l.quantity, l.asPortions);
        for (const p of e.problems)
          errors.push({
            row: l.rowNo,
            column: "item_code",
            message: `explode.${p.kind}`,
            params: { code: p.recipeCode },
          });
        for (const [id, q] of e.usage) add(id, q);
      }
      if (errors.length > 0) return fail(errors);

      const plan = await planConsumptionInTx(tx, ctx, wh, usage);
      if (plan.shortages.length > 0) {
        const skus = new Map([...products.values()].map((p) => [p.id, p.sku]));
        return fail(
          plan.shortages.map((s) => ({
            row: 0,
            column: "",
            message: "INSUFFICIENT_STOCK",
            params: {
              sku: skus.get(s.productId) ?? "",
              required: s.required.toFixed(),
              available: s.available.toFixed(),
            },
          })),
        );
      }
      const year = Number(
        lines
          .map((l) => l.soldOn)
          .sort()
          .at(-1)!
          .slice(0, 4),
      );
      const number = await nextDocumentNumber(tx, ctx.organizationId, "SAL", year);
      const posted = await postConsumptionInTx(tx, ctx, wh, plan.picks, `Sales ${number}`);
      const amounts = lines.filter((l) => l.netAmount !== null);
      const sum = (pick: (l: (typeof lines)[number]) => string | null) => {
        const values = lines.map(pick).filter((v): v is string => v !== null);
        return values.length
          ? roundMoney(values.reduce((a, v) => a.plus(toDecimal(v)), new Decimal(0))).toFixed()
          : null;
      };
      const sales = await tx.salesImport.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          warehouseId: wh.id,
          fileName: input.fileName?.slice(0, 200),
          lineCount: lines.length,
          skippedCount: skipped,
          netAmount: amounts.length
            ? roundMoney(
                amounts.reduce((a, l) => a.plus(toDecimal(l.netAmount as string)), new Decimal(0)),
              ).toFixed()
            : null,
          taxAmount: sum((l) => l.taxAmount),
          grossAmount: sum((l) => l.grossAmount),
          costAmount: posted.cost.toFixed(),
          documentId: posted.documentId,
          postedByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await tx.salesLine.createMany({
        data: lines.map((l) => ({
          organizationId: ctx.organizationId,
          importId: sales.id,
          rowNo: l.rowNo,
          externalId: l.externalId,
          soldOn: new Date(`${l.soldOn}T00:00:00Z`),
          channel: l.channel,
          itemType: l.itemType,
          recipeId: l.recipeId,
          recipeVersionId: l.versionId,
          productId: l.productId,
          quantity: l.quantity.toFixed(),
          netAmount: l.netAmount,
          taxCodeId: l.taxCodeId,
          taxRate: l.taxRate,
          taxAmount: l.taxAmount,
          grossAmount: l.grossAmount,
        })),
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "sales.imported",
        entityType: "sales_import",
        entityId: sales.id,
        changes: {
          number,
          warehouseId: wh.id,
          lines: lines.length,
          skipped,
          cost: posted.cost.toFixed(),
        },
      });
      return {
        ok: true as const,
        errors: [],
        imported: lines.length,
        skipped,
        importId: sales.id,
        number,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error, "sales_lines_active_external_id"))
      throw conflict("Some lines were imported at the same time; upload the file again", {
        reason: "concurrentImport",
      });
    throw error;
  }
}

const reverseSchema = z.object({ reason: requiredText(500) });

/** Undo an import: the consumption is reversed and its external ids may be imported again. */
export async function reverseSalesImport(ctx: TenantContext, importId: string, rawInput: unknown) {
  const parsed = reverseSchema.safeParse(rawInput);
  if (!parsed.success)
    throw businessRuleViolation("REASON_REQUIRED", "Give a reason", { field: "reason" });
  return withTenantTx(ctx.organizationId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "sales_imports" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${importId}::uuid FOR UPDATE`;
    const imp = await tx.salesImport.findFirst({
      where: { organizationId: ctx.organizationId, id: importId },
    });
    if (!imp) throw notFound("Sales import");
    const wh = await loadWarehouse(tx, ctx, imp.warehouseId);
    if (!hasPermission(ctx.grants, "sales.view", { branchId: wh.branchId, warehouseId: wh.id }))
      throw notFound("Sales import");
    assertPermission(ctx.grants, "sales.import", { branchId: wh.branchId, warehouseId: wh.id });
    if (imp.status !== "POSTED")
      throw businessRuleViolation("SALES_IMPORT_REVERSED", "Already reversed");
    const reversal = await reverseDocumentInTx(
      tx,
      ctx,
      imp.documentId,
      { reasonCode: "ENTERED_IN_ERROR", note: parsed.data.reason },
      { allowReceipt: false, allowConsumption: true, permission: "sales.import" },
    );
    await tx.salesLine.updateMany({
      where: { organizationId: ctx.organizationId, importId: imp.id },
      data: { active: false },
    });
    await tx.salesImport.update({
      where: { id: imp.id },
      data: {
        status: "REVERSED",
        reversalDocumentId: reversal.documentId,
        reversedAt: new Date(),
        reversedByUserId: ctx.userId,
        reversalReason: parsed.data.reason,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "sales.reversed",
      entityType: "sales_import",
      entityId: imp.id,
      changes: { number: imp.number, reason: parsed.data.reason },
    });
    return { reversalNumber: reversal.number };
  });
}

function visibleWarehouses(ctx: TenantContext) {
  const scope = accessibleScope(ctx.grants, "sales.view");
  return scope.all
    ? {}
    : {
        warehouse: {
          OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }],
        },
      };
}

export async function listSalesImports(ctx: TenantContext) {
  if (!holdsAnyGrant(ctx.grants, "sales.view")) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.salesImport.findMany({
      where: { organizationId: ctx.organizationId, ...visibleWarehouses(ctx) },
      include: { warehouse: { select: { code: true, name: true } } },
      orderBy: { postedAt: "desc" },
      take: 200,
    }),
  );
}

export async function getSalesImport(ctx: TenantContext, importId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const imp = await tx.salesImport.findFirst({
      where: { organizationId: ctx.organizationId, id: importId },
      include: {
        warehouse: { select: { id: true, code: true, name: true, branchId: true } },
        document: { select: { id: true, number: true } },
        reversal: { select: { id: true, number: true } },
        lines: {
          orderBy: { rowNo: "asc" },
          include: {
            recipe: { select: { id: true, code: true, name: true, nameAr: true } },
            recipeVersion: { select: { versionNo: true } },
            product: {
              select: {
                id: true,
                sku: true,
                nameEn: true,
                nameAr: true,
                baseUom: { select: { code: true } },
              },
            },
          },
        },
      },
    });
    if (
      !imp ||
      !hasPermission(ctx.grants, "sales.view", {
        branchId: imp.warehouse.branchId,
        warehouseId: imp.warehouse.id,
      })
    )
      throw notFound("Sales import");
    const usage = await tx.inventoryLedgerEntry.findMany({
      where: { organizationId: ctx.organizationId, documentId: imp.documentId },
      select: {
        id: true,
        quantityDelta: true,
        valueDelta: true,
        product: {
          select: { sku: true, nameEn: true, nameAr: true, baseUom: { select: { code: true } } },
        },
        lot: { select: { id: true, lotCode: true } },
      },
      orderBy: { id: "asc" },
    });
    const costVisible = hasPermission(ctx.grants, "inventory.valuation.view", {
      branchId: imp.warehouse.branchId,
      warehouseId: imp.warehouse.id,
    });
    return {
      ...imp,
      costAmount: costVisible ? imp.costAmount : null,
      usage: usage.map((u) => ({
        ...u,
        quantity: dec(u.quantityDelta).negated(),
        value: costVisible ? dec(u.valueDelta).negated() : null,
      })),
      canReverse:
        imp.status === "POSTED" &&
        hasPermission(ctx.grants, "sales.import", {
          branchId: imp.warehouse.branchId,
          warehouseId: imp.warehouse.id,
        }),
    };
  });
}
