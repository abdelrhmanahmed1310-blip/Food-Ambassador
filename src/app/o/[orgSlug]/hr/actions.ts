"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addEmployeeDocument,
  changeEmployeeStatus,
  createDepartment,
  createEmployee,
  removeEmployeeDocument,
  setDepartmentArchived,
  updateEmployee,
} from "@/modules/hr/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createEmployeeAction(orgSlug: string, previous: S, formData: FormData) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createEmployee(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/hr/employees/${id}`);
  return state;
}

export async function updateEmployeeAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateEmployee(ctx, employeeId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function changeStatusAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("hr");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await changeEmployeeStatus(ctx, employeeId, formValues(formData));
    return { message: t("statusChanged") };
  });
}

export async function addDocumentAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("hr");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addEmployeeDocument(ctx, employeeId, formValues(formData));
    return { message: t("documentAdded") };
  });
}

export async function removeDocumentAction(
  orgSlug: string,
  documentId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await removeEmployeeDocument(ctx, documentId);
  });
}

export async function createDepartmentAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("hr");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createDepartment(ctx, formValues(formData));
    return { message: t("departmentAdded") };
  });
}

export async function archiveDepartmentAction(
  orgSlug: string,
  departmentId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setDepartmentArchived(ctx, departmentId, true);
  });
}
