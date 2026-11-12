import "server-only";
import { parseCsvRecords, toCsv } from "@/lib/csv";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { ImportResult, RowError } from "@/modules/inventory/csv";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { MAX_CATEGORY_DEPTH, placementProblem } from "./category-tree";
import { categorySchema } from "./schemas";

/**
 * Bulk upload of product categories and subcategories (DECISIONS.md
 * ADR-134). Columns: code, name, name_ar, parent_code. A parent may be an
 * existing category or another row of the file, in any order. Like the
 * product import, it only adds: an existing code is an error, never an
 * update, and nothing is written unless every row is valid.
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

export async function importCategories(ctx: TenantContext, text: string): Promise<ImportResult> {
  assertPermission(ctx.grants, "catalog.manage");
  let parsed: ReturnType<typeof parseCsvRecords>;
  try {
    parsed = parseCsvRecords(text);
  } catch {
    return { ok: false, imported: 0, errors: [{ row: 0, column: "", message: "csvMalformed" }] };
  }
  const { headers, records } = parsed;
  if (records.length === 0 || records.length > MAX_CATEGORY_ROWS)
    return {
      ok: false,
      imported: 0,
      errors: [
        { row: 0, column: "", message: records.length === 0 ? "csvEmpty" : "csvTooManyRows" },
      ],
    };
  const missing = ["code", "name"].filter((c) => !headers.includes(c));
  if (missing.length)
    return {
      ok: false,
      imported: 0,
      errors: missing.map((column) => ({ row: 0, column, message: "csvMissingColumn" })),
    };

  return withTenantTx(ctx.organizationId, async (tx) => {
    const existing = await tx.productCategory.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true, parentId: true, archivedAt: true },
    });
    const byCode = new Map(existing.map((c) => [c.code, c]));
    const errors: RowError[] = [];
    const rows: Array<{
      row: number;
      code: string;
      name: string;
      nameAr: string | null;
      parentCode: string | null;
    }> = [];
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
      if (byCode.has(code)) errors.push({ row, column: "code", message: "categoryCodeTaken" });
      else if (seen.has(code))
        errors.push({ row, column: "code", message: "categoryDuplicateInFile" });
      seen.add(code);
      const parentCode = (r.parent_code ?? "").trim().toUpperCase() || null;
      rows.push({
        row,
        code,
        name: result.data.name,
        nameAr: result.data.nameAr ?? null,
        parentCode,
      });
    });
    // Parents: an existing, active category or a row of this file.
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
    if (errors.length) return { ok: false, imported: 0, errors };

    // Check the whole tree as it would be: loops through the file, at most three levels.
    const nodes = [
      ...existing.map((c) => ({ id: c.id, parentId: c.parentId })),
      ...rows.map((r) => ({
        id: `new:${r.code}`,
        parentId: r.parentCode ? (byCode.get(r.parentCode)?.id ?? `new:${r.parentCode}`) : null,
      })),
    ];
    for (const r of rows) {
      const node = nodes.find((n) => n.id === `new:${r.code}`)!;
      const problem = placementProblem(
        node.id,
        node.parentId,
        nodes.filter((n) => n.id !== node.id).concat([{ id: node.id, parentId: null }]),
      );
      if (problem) errors.push({ row: r.row, column: "parent_code", message: problem });
    }
    if (errors.length) return { ok: false, imported: 0, errors };

    // Create parents before children.
    const ids = new Map(existing.map((c) => [c.code, c.id]));
    const pending = [...rows];
    let guard = 0;
    while (pending.length && guard++ <= MAX_CATEGORY_DEPTH + 1) {
      for (const r of [...pending]) {
        if (r.parentCode && !ids.has(r.parentCode)) continue;
        const created = await tx.productCategory.create({
          data: {
            organizationId: ctx.organizationId,
            code: r.code,
            name: r.name,
            nameAr: r.nameAr,
            parentId: r.parentCode ? ids.get(r.parentCode)! : null,
          },
          select: { id: true },
        });
        ids.set(r.code, created.id);
        pending.splice(pending.indexOf(r), 1);
      }
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "category.imported",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { count: rows.length },
    });
    return { ok: true, imported: rows.length, errors: [] };
  });
}
