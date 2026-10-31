"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { MAX_ATTACHMENT_BYTES } from "@/modules/attachments/rules";
import {
  removeAttachment,
  uploadAttachment,
  type AttachmentEntity,
} from "@/modules/attachments/service";
import { tenantMutation } from "@/server/actions/tenant";

export async function uploadAttachmentAction(
  orgSlug: string,
  entityType: AttachmentEntity,
  entityId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("attachments");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("fileRequired") };
  if (file.size > MAX_ATTACHMENT_BYTES)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("tooLarge") };
  const bytes = new Uint8Array(await file.arrayBuffer());
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await uploadAttachment(ctx, { entityType, entityId }, { name: file.name, bytes });
    return { message: t("uploaded") };
  });
}

export async function removeAttachmentAction(
  orgSlug: string,
  attachmentId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removeAttachment(ctx, attachmentId));
}
