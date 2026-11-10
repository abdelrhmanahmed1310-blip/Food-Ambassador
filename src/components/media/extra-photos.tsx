"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { initialActionState, type ActionState } from "@/components/forms/action-state";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { SubmitButton } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Up to four more photos after the main one (ADR-133); menu boards show them in turn. */
export function ExtraPhotos({
  photos,
  add,
  max,
}: {
  photos: Array<{ id: string; url: string; remove: Action }>;
  add: Action;
  max: number;
}) {
  const t = useTranslations("photos");
  const [state, addAction] = useActionState(add, initialActionState);
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t("extraTitle", { count: photos.length, max })}</p>
      {photos.length > 0 ? (
        <ul className="flex flex-wrap gap-3" data-testid="extra-photos">
          {photos.map((p) => (
            <li key={p.id} className="space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element -- served from /media with long-lived caching */}
              <img src={p.url} alt="" className="size-24 rounded-lg object-cover" />
              <ConfirmActionButton action={p.remove} label={t("remove")} variant="secondary" />
            </li>
          ))}
        </ul>
      ) : null}
      {photos.length < max ? (
        <form action={addAction} className="flex flex-wrap items-end gap-2">
          <label className="text-sm" htmlFor="extra-photo-file">
            <span className="mb-1 block">{t("extraAdd")}</span>
            <input
              id="extra-photo-file"
              name="photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              required
              className="block text-sm"
            />
          </label>
          <SubmitButton label={t("add")} pendingLabel={t("uploading")} variant="secondary" />
          {state.formError ? (
            <p role="alert" className="text-danger w-full text-sm">
              {state.fieldErrors?.photo ?? state.formError}
            </p>
          ) : state.ok && state.message ? (
            <p role="status" className="text-success w-full text-sm">
              {state.message}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
