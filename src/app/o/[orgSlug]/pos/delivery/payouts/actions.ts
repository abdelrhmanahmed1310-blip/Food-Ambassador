"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  confirmDeliveryPayout,
  deleteDeliveryPayout,
  importDeliveryPayout,
} from "@/modules/delivery/payouts";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

const MAX_UPLOAD_BYTES = 900_000;

export async function importPayoutAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_UPLOAD_BYTES)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("import.fileRequired") };
  const text = await file.text();
  const values = formValues(formData);
  delete values.file;
  let payoutId: string | null = null;
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await importDeliveryPayout(ctx, values, { fileName: file.name, text });
    if (!r.ok) {
      const errors = r.errors.map((e) => {
        const key = [`delivery.payouts.errors.${e.message}`, `validation.${e.message}`].find((k) =>
          t.has(k),
        );
        return { row: e.row, column: e.column, message: key ? t(key) : e.message };
      });
      return {
        ok: false,
        formError: t("import.rejected", { count: errors.length }),
        data: { errors: JSON.stringify(errors) },
      };
    }
    payoutId = r.payoutId;
    return { message: t("delivery.payouts.imported", { count: r.lines }) };
  });
  if (state.ok && payoutId) redirect(`/o/${orgSlug}/pos/delivery/payouts/${payoutId}`);
  return state;
}

export async function confirmPayoutAction(
  orgSlug: string,
  payoutId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations();
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await confirmDeliveryPayout(ctx, payoutId);
    return { message: t("delivery.payouts.confirmed", { count: r.settled }) };
  });
}

export async function deletePayoutAction(
  orgSlug: string,
  payoutId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await deleteDeliveryPayout(ctx, payoutId);
    return {};
  });
  if (state.ok) redirect(`/o/${orgSlug}/pos/delivery/payouts`);
  return state;
}
