"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { importSales, reverseSalesImport, type SalesRowError } from "@/modules/sales/imports";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

// Same limit as the catalog import (under the server action body limit).
const MAX_UPLOAD_BYTES = 900_000;

async function translate(errors: SalesRowError[]) {
  const t = await getTranslations();
  return errors.slice(0, 300).map((e) => {
    const key = [`sales.errors.${e.message}`, `validation.${e.message}`, `rules.${e.message}`].find(
      (k) => t.has(k),
    );
    let message = e.message;
    if (key) {
      try {
        message = t(key, { code: "", sku: "", required: "", available: "", ...e.params });
      } catch {
        message = e.message;
      }
    }
    return { row: e.row, column: e.column, message };
  });
}

export async function importSalesAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations();
  const file = formData.get("file");
  const warehouseId = String(formData.get("warehouseId") ?? "");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_UPLOAD_BYTES)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("import.fileRequired") };
  if (!warehouseId)
    return {
      ok: false,
      seq: (previous.seq ?? 0) + 1,
      fieldErrors: { warehouseId: t("validation.required") },
    };
  const text = await file.text();
  return tenantMutation(orgSlug, previous, formData, async (ctx): Promise<Partial<ActionState>> => {
    const r = await importSales(ctx, { warehouseId, fileName: file.name, text });
    if (!r.ok)
      return {
        ok: false,
        formError: t("import.rejected", { count: r.errors.length }),
        data: { errors: JSON.stringify(await translate(r.errors)) },
      };
    return {
      message: t("sales.imported", { count: r.imported, skipped: r.skipped }),
      data: r.importId ? { importId: r.importId, number: r.number ?? "" } : {},
    };
  });
}

export async function reverseSalesImportAction(
  orgSlug: string,
  importId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await reverseSalesImport(ctx, importId, formValues(formData));
  });
}
