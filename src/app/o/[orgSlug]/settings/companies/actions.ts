"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  createBrand,
  createCompany,
  setBrandArchived,
  setCompanyArchived,
  setDefaultCompany,
  updateCompany,
} from "@/modules/organizations/companies";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

export async function createCompanyAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("companies");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createCompany(ctx, formValues(formData));
    return { message: t("added") };
  });
}

export async function updateCompanyAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateCompany(ctx, id, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function setDefaultCompanyAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => setDefaultCompany(ctx, id));
}

export async function archiveCompanyAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => setCompanyArchived(ctx, id, true));
}

export async function createBrandAction(orgSlug: string, previous: S, formData: FormData) {
  const t = await getTranslations("companies");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createBrand(ctx, formValues(formData));
    return { message: t("brandAdded") };
  });
}

export async function archiveBrandAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => setBrandArchived(ctx, id, true));
}
