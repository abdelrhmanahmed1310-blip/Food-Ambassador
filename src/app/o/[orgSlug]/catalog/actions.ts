"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addBarcode,
  addConversion,
  createProduct,
  createUnit,
  removeBarcode,
  removeConversion,
  setProductArchived,
  updateProduct,
} from "@/modules/catalog/service";
import { importOpeningBalances, importProducts, type ImportResult } from "@/modules/inventory/csv";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";
import { translateRowErrors } from "@/server/actions/import-errors";

export async function createProductAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createProduct(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/catalog/products/${id}`);
  return state;
}

export async function updateProductAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateProduct(ctx, productId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function setProductArchivedAction(
  orgSlug: string,
  productId: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setProductArchived(ctx, productId, archived),
  );
}

export async function addBarcodeAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addBarcode(ctx, productId, formValues(formData)),
  );
}

export async function removeBarcodeAction(
  orgSlug: string,
  productId: string,
  barcodeId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeBarcode(ctx, productId, barcodeId),
  );
}

export async function addConversionAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addConversion(ctx, productId, formValues(formData)),
  );
}

export async function removeConversionAction(
  orgSlug: string,
  productId: string,
  conversionId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeConversion(ctx, productId, conversionId),
  );
}

export async function createUnitAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("catalog");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createUnit(ctx, formValues(formData));
    return { message: t("unitCreated") };
  });
}

const MAX_UPLOAD_BYTES = 900_000;

async function readUpload(formData: FormData): Promise<string | null> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_UPLOAD_BYTES) return null;
  return file.text();
}

async function importAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
  run: (ctx: Parameters<typeof importProducts>[0], text: string) => Promise<ImportResult>,
): Promise<ActionState> {
  const t = await getTranslations();
  const text = await readUpload(formData);
  if (text === null)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("import.fileRequired") };
  return tenantMutation(orgSlug, previous, formData, async (ctx): Promise<Partial<ActionState>> => {
    const result = await run(ctx, text);
    if (!result.ok) {
      return {
        ok: false,
        formError: t("import.rejected", { count: result.errors.length }),
        data: { errors: JSON.stringify(await translateRowErrors(result.errors)) },
      };
    }
    return {
      message: t("import.done", { count: result.imported }),
      data: { documents: (result.documents ?? []).join(", ") },
    };
  });
}

export async function importProductsAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return importAction(orgSlug, previous, formData, importProducts);
}

export async function importOpeningBalancesAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return importAction(orgSlug, previous, formData, importOpeningBalances);
}
