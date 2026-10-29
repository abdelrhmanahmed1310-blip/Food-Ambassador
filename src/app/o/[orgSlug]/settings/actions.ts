"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { createRole, updateRole } from "@/modules/access/roles";
import {
  createInvitation,
  grantRole,
  removeMember,
  revokeInvitation,
  revokeRole,
} from "@/modules/members/service";
import { updateOrganization } from "@/modules/organizations/service";
import { formList, formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";
import { getEnv } from "@/server/env";

export async function updateOrganizationAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const values = formValues(formData);
    await updateOrganization(ctx, {
      name: values.name ?? "",
      timeZone: values.timeZone ?? "",
      defaultLocale: values.defaultLocale as "en" | "ar",
    });
    return { message: t("savedSuccessfully") };
  });
}

export async function inviteMemberAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const values = formValues(formData);
    const { token } = await createInvitation(ctx, values);
    // The link is shown once to the inviter; only its hash is stored.
    return {
      data: {
        inviteUrl: `${getEnv().APP_URL}/invite/${token}`,
        email: values.email?.trim().toLowerCase() ?? "",
      },
    };
  });
}

export async function revokeInvitationAction(
  orgSlug: string,
  invitationId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) => revokeInvitation(ctx, invitationId));
}

export async function grantRoleAction(
  orgSlug: string,
  membershipId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    grantRole(ctx, membershipId, formValues(formData)),
  );
}

export async function revokeRoleAction(
  orgSlug: string,
  membershipId: string,
  grantId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    revokeRole(ctx, membershipId, grantId),
  );
}

export async function removeMemberAction(
  orgSlug: string,
  membershipId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const state = await tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeMember(ctx, membershipId),
  );
  if (state.ok) redirect(`/o/${orgSlug}/settings/members`);
  return state;
}

function roleInput(formData: FormData) {
  const values = formValues(formData);
  return {
    name: values.name,
    description: values.description,
    permissions: formList(formData, "permissions"),
  };
}

export async function createRoleAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createRole(ctx, roleInput(formData));
  });
  if (state.ok) redirect(`/o/${orgSlug}/settings/roles`);
  return state;
}

export async function updateRoleAction(
  orgSlug: string,
  roleId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateRole(ctx, roleId, roleInput(formData));
    return { message: t("savedSuccessfully") };
  });
}
