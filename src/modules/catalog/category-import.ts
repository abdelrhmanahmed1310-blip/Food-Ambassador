import "server-only";
import { parseCsvRecords, toCsv } from "@/lib/csv";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { ImportResult, RowError } from "@/modules/inventory/csv";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { lineage, placementProblem } from "./category-tree";
import { categorySchema } from "./schemas";

/**
 * Bulk upload of product categories and subcategories (DECISIONS.md
 * ADR-134). Columns: code, name, name_ar, parent_code. A row with a new code
 * creates a category; a row with an existing code updates its names and its
 * parent (an empty parent_code makes it a main category). A parent may be an
 * existing category or another row of the file, in any order. The tree as
 * it would be after the upload is checked first; nothing is written unless
 * every row is valid.
 */

export const MAX_CATEGORY_ROWS = 2000;

export const CATEGORY_TEMPLATE = toCsv(
  ["code", "name", "name_ar", "parent_code"],
  [
    ["BEV", "Beverages", "مشروبات", ""],
    ["BEV-HOT", "Hot drinks", "مشروبات ساخنة", "BEV"],
    ["BEV-COLD", "Cold drinks", "مشروبات باردة", "BEV"],
    ["DAIRY", "Dairy", "ألبان", ""],
  ],
);

const COLUMN: Record<string, string> = { code: "code", name: "name", nameAr: "name_ar" };

export interface CategoryImportResult extends ImportResult {
  created: number;
  updated: number;
}

export async function importCategories(
  ctx: TenantContext,
  text: string,
): Promise<CategoryImportResult> {
  assertPermission(ctx.grants, "catalog.manage");
  const fail = (errors: RowError[]): CategoryImportResult => ({
    ok: false,
    imported: 0,
    created: 0,
    updated: 0,
    errors,
  });
  let parsed: ReturnType<typeof parseCsvRecords>;
  try {
    parsed = parseCsvRecords(text);
  } catch {
    return fail([{ row: 0, column: "", message: "csvMalformed" }]);
  }
  const { headers, records } = parsed;
  if (records.length === 0 || records.length > MAX_CATEGORY_ROWS)
    return fail([
      { row: 0, column: "", message: records.length === 0 ? "csvEmpty" : "csvTooManyRows" },
    ]);
  const missing = ["code", "name"].filter((c) => !headers.includes(c));
  if (missing.length)
    return fail(missing.map((column) => ({ row: 0, column, message: "csvMissingColumn" })));
  const hasParentColumn = headers.includes("parent_code");

  return withTenantTx(ctx.organizationId, async (tx) => {
    const existing = await tx.productCategory.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, nameAr: true, parentId: true, archivedAt: true },
    });
    const byCode = new Map(existing.map((c) => [c.code, c]));
    const codeOf = new Map(existing.map((c) => [c.id, c.code]));
    const errors: RowError[] = [];
    type Row = {
      row: number;
      code: string;
      name: string;
      nameAr: string | null;
      parentCode: string | null;
      existingId: string | null;
    };
    const rows: Row[] = [];
    const seen = new Set<string>();
    records.forEach((r, i) => {
      const row = i + 1;
      const result = categorySchema.safeParse({ code: r.code, name: r.name, nameAr: r.name_ar });
      if (!result.success) {
        for (const issue of result.error.issues)
          errors.push({
            row,
            column: COLUMN[String(issue.path[0])] ?? String(issue.path[0]),
            message: issue.message,
          });
        return;
      }
      const code = result.data.code;
      if (seen.has(code)) errors.push({ row, column: "code", message: "categoryDuplicateInFile" });
      seen.add(code);
      const current = byCode.get(code) ?? null;
      // Without a parent_code column, an existing category keeps its parent.
      const parentCode = hasParentColumn
        ? (r.parent_code ?? "").trim().toUpperCase() || null
        : current?.parentId
          ? (codeOf.get(current.parentId) ?? null)
          : null;
      rows.push({
        row,
        code,
        name: result.data.name,
        nameAr: result.data.nameAr ?? null,
        parentCode,
        existingId: current?.id ?? null,
      });
    });
    const inFile = new Set(rows.map((r) => r.code));
    for (const r of rows) {
      if (!r.parentCode) continue;
      if (r.parentCode === r.code)
        errors.push({ row: r.row, column: "parent_code", message: "CATEGORY_LOOP" });
      else if (!inFile.has(r.parentCode) && !byCode.has(r.parentCode))
        errors.push({ row: r.row, column: "parent_code", message: "categoryUnknownParent" });
      else if (byCode.get(r.parentCode)?.archivedAt)
        errors.push({ row: r.row, column: "parent_code", message: "CATEGORY_ARCHIVED" });
    }
    if (errors.length) return fail(errors);

    // The tree as it would be after the upload: loops and depth checked on it.
    const idOf = (code: string) => byCode.get(code)?.id ?? `new:${code}`;
    const rowFor = new Map(rows.map((r) => [r.code, r]));
    const nodes = [
      ...existing.map((c) => {
        const r = rowFor.get(c.code);
        return { id: c.id, parentId: r ? (r.parentCode ? idOf(r.parentCode) : null) : c.parentId };
      }),
      ...rows
        .filter((r) => !r.existingId)
        .map((r) => ({ id: idOf(r.code), parentId: r.parentCode ? idOf(r.parentCode) : null })),
    ];
    for (const r of rows) {
      const node = nodes.find((n) => n.id === idOf(r.code))!;
      const detached = nodes.map((n) => (n.id === node.id ? { id: n.id, parentId: null } : n));
      const problem = placementProblem(node.id, node.parentId, detached);
      if (problem) errors.push({ row: r.row, column: "parent_code", message: problem });
    }
    if (errors.length) return fail(errors);

    // Detach moved categories first, then place everything from the top down, so
    // no step passes through a loop or a fourth level.
    const moved = rows.filter(
      (r) =>
        r.existingId &&
        (byCode.get(r.code)!.parentId ?? null) !== (r.parentCode ? idOf(r.parentCode) : null),
    );
    if (moved.length)
      await tx.productCategory.updateMany({
        where: { organizationId: ctx.organizationId, id: { in: moved.map((r) => r.existingId!) } },
        data: { parentId: null },
      });
    const parents = new Map(nodes.map((n) => [n.id, n.parentId]));
    const depth = (r: Row) => lineage(idOf(r.code), parents).length;
    const ids = new Map(existing.map((c) => [c.code, c.id]));
    let created = 0;
    let updated = 0;
    for (const r of [...rows].sort((a, b) => depth(a) - depth(b))) {
      const parentId = r.parentCode ? ids.get(r.parentCode)! : null;
      if (r.existingId) {
        const before = byCode.get(r.code)!;
        if (
          before.name !== r.name ||
          (before.nameAr ?? null) !== r.nameAr ||
          (before.parentId ?? null) !== parentId
        ) {
          await tx.productCategory.update({
            where: { id: r.existingId },
            data: { name: r.name, nameAr: r.nameAr, parentId },
          });
          updated++;
        } else if (moved.some((m) => m.code === r.code)) {
          await tx.productCategory.update({ where: { id: r.existingId }, data: { parentId } });
        }
      } else {
        const c = await tx.productCategory.create({
          data: {
            organizationId: ctx.organizationId,
            code: r.code,
            name: r.name,
            nameAr: r.nameAr,
            parentId,
          },
          select: { id: true },
        });
        ids.set(r.code, c.id);
        created++;
      }
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "category.imported",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { created, updated, unchanged: rows.length - created - updated },
    });
    return { ok: true, imported: created + updated, created, updated, errors: [] };
  });
}
