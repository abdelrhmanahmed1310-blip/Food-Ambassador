"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { initialActionState, type ActionState } from "@/components/forms/action-state";
import { SubmitButton } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function AttachmentUploadForm({ action }: { action: Action }) {
  const t = useTranslations("attachments");
  const [state, formAction] = useActionState(action, initialActionState);
  // A rule on the file itself (size, type) is reported on the field.
  const fileError = state.fieldErrors?.file;
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3" key={state.seq ?? 0}>
      <div>
        <label htmlFor="attachment-file" className="mb-1 block text-sm font-medium">
          {t("file")}
        </label>
        <input
          id="attachment-file"
          name="file"
          type="file"
          required
          accept="application/pdf,image/jpeg,image/png,image/webp"
          aria-invalid={fileError ? true : undefined}
          aria-describedby={fileError ? "attachment-file-error" : "attachment-file-hint"}
          className="text-sm"
        />
        {fileError ? (
          <p id="attachment-file-error" role="alert" className="text-danger mt-1 text-xs">
            {fileError}
          </p>
        ) : (
          <p id="attachment-file-hint" className="text-muted mt-1 text-xs">
            {t("fileHint")}
          </p>
        )}
      </div>
      <SubmitButton label={t("upload")} pendingLabel={t("uploading")} variant="secondary" />
      {state.formError && !fileError ? (
        <p role="alert" className="text-danger w-full text-sm">
          {state.formError}
        </p>
      ) : state.ok && state.message ? (
        <p role="status" className="text-success w-full text-sm">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
