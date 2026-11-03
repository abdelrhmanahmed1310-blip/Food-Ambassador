"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  createSupplier,
  removeSupplierProduct,
  saveSupplierProduct,
  setSupplierArchived,
  updateSupplier,
} from "@/modules/procurement/suppliers";
import {
  addSupplierBankAccount,
  addSupplierDocument,
  approveSupplier,
  archiveSupplierBankAccount,
  archiveSupplierDocument,
  blockSupplier,
  revealSupplierBankAccount,
  unblockSupplier,
  updateSupplierDocument,
  verifySupplierBankAccount,
} from "@/modules/procurement/compliance";
import { groupedAccount } from "@/modules/procurement/compliance-rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { formValues, runFormAction } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function createSupplierAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createSupplier(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/suppliers/${id}`);
  return state;
}

export async function updateSupplierAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateSupplier(ctx, supplierId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function setSupplierArchivedAction(
  orgSlug: string,
  supplierId: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setSupplierArchived(ctx, supplierId, archived),
  );
}

export async function saveSupplierProductAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await saveSupplierProduct(ctx, supplierId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function removeSupplierProductAction(
  orgSlug: string,
  supplierId: string,
  supplierProductId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeSupplierProduct(ctx, supplierId, supplierProductId),
  );
}

// ─── Compliance (ADR-091) ───

export async function approveSupplierAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) => approveSupplier(ctx, supplierId));
}

export async function blockSupplierAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    blockSupplier(ctx, supplierId, formValues(formData)),
  );
}

export async function unblockSupplierAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) => unblockSupplier(ctx, supplierId));
}

export async function addSupplierDocumentAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addSupplierDocument(ctx, supplierId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function updateSupplierDocumentAction(
  orgSlug: string,
  supplierId: string,
  documentId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateSupplierDocument(ctx, supplierId, documentId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function archiveSupplierDocumentAction(
  orgSlug: string,
  supplierId: string,
  documentId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    archiveSupplierDocument(ctx, supplierId, documentId),
  );
}

export async function addSupplierBankAccountAction(
  orgSlug: string,
  supplierId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  // The account number is never sent back to the browser in `values`.
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addSupplierBankAccount(ctx, supplierId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
  if (state.values) state.values = { ...state.values, account: "" };
  return state;
}

export async function verifySupplierBankAccountAction(
  orgSlug: string,
  supplierId: string,
  accountId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    verifySupplierBankAccount(ctx, supplierId, accountId),
  );
}

export async function archiveSupplierBankAccountAction(
  orgSlug: string,
  supplierId: string,
  accountId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    archiveSupplierBankAccount(ctx, supplierId, accountId),
  );
}

export async function revealSupplierBankAccountAction(
  orgSlug: string,
  supplierId: string,
  accountId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireTenant(orgSlug);
  // Read-only (only an audit entry is written): no page refresh needed.
  return runFormAction(previous, formData, async () => {
    const { account } = await revealSupplierBankAccount(ctx, supplierId, accountId);
    return { data: { account: groupedAccount(account) } };
  });
}
