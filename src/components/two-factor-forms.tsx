"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { initialActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, TextField } from "@/components/forms/fields";
import { buttonClass, inputClass } from "@/components/ui/styles";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** The code from the authenticator app, or a backup code. */
export function SecondFactorForm({ action, next }: { action: Action; next?: string }) {
  const t = useTranslations("auth");
  return (
    <ActionForm action={action} submitLabel={t("verify")} pendingLabel={t("verify")}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <TextField
        name="code"
        label={t("code")}
        hint={t("codeHint")}
        autoComplete="one-time-code"
        inputMode="numeric"
        dir="ltr"
        required
      />
      <CheckboxField name="backup" label={t("useBackupCode")} />
    </ActionForm>
  );
}

/** Turn two-factor sign-in on (password → QR and backup codes → first code) or off. */
export function TwoFactorSetup({
  enabled,
  enable,
  confirm,
  disable,
}: {
  enabled: boolean;
  enable: Action;
  confirm: Action;
  disable: Action;
}) {
  const t = useTranslations("auth");
  const [started, startAction, starting] = useActionState(enable, initialActionState);
  const [qr, setQr] = useState<string | null>(null);
  const uri = started.ok ? String(started.data?.totpURI ?? "") : "";
  const secret = uri ? (new URL(uri).searchParams.get("secret") ?? "") : "";
  useEffect(() => {
    if (!uri) return;
    void import("qrcode").then((q) => q.default.toDataURL(uri, { margin: 1 }).then(setQr));
  }, [uri]);

  if (enabled)
    return (
      <ActionForm
        action={disable}
        submitLabel={t("turnOff")}
        pendingLabel={t("turnOff")}
        submitVariant="danger"
      >
        <TextField
          name="password"
          type="password"
          label={t("password")}
          autoComplete="current-password"
          dir="ltr"
          required
        />
      </ActionForm>
    );

  if (!uri)
    return (
      <form action={startAction} className="space-y-3">
        <div>
          <label htmlFor="tf-password" className="mb-1 block text-sm font-medium">
            {t("password")}
          </label>
          <input
            id="tf-password"
            name="password"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            required
            className={inputClass}
          />
        </div>
        {!started.ok && started.formError ? (
          <p role="alert" className="text-danger text-sm">
            {started.formError}
          </p>
        ) : null}
        <button type="submit" className={buttonClass("primary")} disabled={starting}>
          {t("turnOn")}
        </button>
      </form>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm">{t("scanQr")}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {qr ? <img src={qr} alt={t("qrAlt")} className="h-44 w-44" /> : null}
      <p className="text-sm">
        {t("orEnterKey")}{" "}
        <code className="ltr-value font-mono break-all" data-testid="totp-secret">
          {secret}
        </code>
      </p>
      <div className="bg-warning-surface rounded-md p-3 text-sm">
        <p className="font-medium">{t("backupCodes")}</p>
        <p className="text-muted mb-2">{t("backupCodesHint")}</p>
        <p className="ltr-value font-mono" data-testid="backup-codes">
          {String(started.data?.backupCodes ?? "")}
        </p>
      </div>
      <ActionForm action={confirm} submitLabel={t("confirmCode")} pendingLabel={t("confirmCode")}>
        <TextField
          name="code"
          label={t("code")}
          autoComplete="one-time-code"
          inputMode="numeric"
          dir="ltr"
          required
        />
      </ActionForm>
    </div>
  );
}
