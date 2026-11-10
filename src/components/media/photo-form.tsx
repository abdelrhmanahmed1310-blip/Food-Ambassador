"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { initialActionState, type ActionState } from "@/components/forms/action-state";
import { SubmitButton } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * A product or menu item photo (ADR-133): the current photo, a file to upload
 * (JPEG, PNG or WebP, up to 5 MB; the server re-encodes it) and removal.
 */
export function PhotoForm({
  imageUrl,
  alt,
  upload,
  remove,
  inherited = false,
}: {
  imageUrl: string | null;
  alt: string;
  upload: Action;
  remove: Action;
  /** The photo shown is the linked product's, not the item's own. */
  inherited?: boolean;
}) {
  const t = useTranslations("photos");
  const [up, uploadAction] = useActionState(upload, initialActionState);
  const [rm, removeAction] = useActionState(remove, initialActionState);
  const message = (s: ActionState) =>
    s.formError ? (
      <p role="alert" className="text-danger text-sm">
        {s.fieldErrors?.photo ?? s.formError}
      </p>
    ) : s.ok && s.message ? (
      <p role="status" className="text-success text-sm">
        {s.message}
      </p>
    ) : null;
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="border-border bg-surface-muted flex size-40 shrink-0 items-center justify-center overflow-hidden rounded-xl border">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- served from /media with long-lived caching
          <img src={imageUrl} alt={alt} className="size-full object-cover" data-testid="photo" />
        ) : (
          <span className="text-muted px-2 text-center text-xs">{t("none")}</span>
        )}
      </div>
      <div className="space-y-3">
        {inherited && imageUrl ? <p className="text-muted text-sm">{t("inherited")}</p> : null}
        <form action={uploadAction} className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="photo-file">
            {t("choose")}
          </label>
          <input
            id="photo-file"
            name="photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            required
            className="block text-sm"
          />
          <p className="text-muted text-xs">{t("hint")}</p>
          <SubmitButton label={t("upload")} pendingLabel={t("uploading")} />
          {message(up)}
        </form>
        {imageUrl && !inherited ? (
          <form action={removeAction}>
            <SubmitButton label={t("remove")} pendingLabel={t("uploading")} variant="secondary" />
            {message(rm)}
          </form>
        ) : null}
      </div>
    </div>
  );
}
