"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { initialActionState, type ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField, useFormState } from "@/components/forms/fields";
import { SecretOnce } from "@/components/integrations/forms";
import { buttonClass, inputClass } from "@/components/ui/styles";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

/** The branch tablet: employee number and PIN; the result shows for a few seconds. */
export function ClockPad({ action }: { action: Action }) {
  const t = useTranslations("attendance");
  const [state, formAction, pending] = useActionState(action, initialActionState);
  // The result shows for a few seconds after each tap, then the pad is clear again.
  const [hiddenSeq, setHiddenSeq] = useState(0);
  useEffect(() => {
    if (!state.seq) return;
    const seq = state.seq;
    const timer = window.setTimeout(() => setHiddenSeq(seq), 5000);
    return () => window.clearTimeout(timer);
  }, [state.seq]);
  const visible = Boolean(state.seq) && hiddenSeq !== state.seq;
  return (
    <div className="mx-auto w-full max-w-md space-y-6">
      {visible && state.ok ? (
        <div
          role="status"
          data-testid="clock-result"
          className={`rounded-2xl p-6 text-center text-white ${state.data?.kind === "IN" ? "bg-success" : "bg-foreground"}`}
        >
          <p className="text-2xl font-bold">
            {state.data?.kind === "IN"
              ? t("welcome", { name: state.data?.name ?? "" })
              : t("goodbye", { name: state.data?.name ?? "" })}
          </p>
          <p className="mt-1 text-lg">
            {state.data?.kind === "IN"
              ? t("clockedIn", { time: state.data?.time ?? "" })
              : t("clockedOut", { time: state.data?.time ?? "" })}
          </p>
        </div>
      ) : null}
      {visible && !state.ok && state.formError ? (
        <p
          role="alert"
          className="border-danger/40 bg-danger-surface text-danger rounded-xl border p-4 text-center text-lg"
        >
          {state.formError}
        </p>
      ) : null}
      <form action={formAction} key={state.seq} className="space-y-4">
        <div>
          <label htmlFor="employeeNumber" className="mb-1 block text-lg font-medium">
            {t("employeeNumber")}
          </label>
          <input
            id="employeeNumber"
            name="employeeNumber"
            required
            autoComplete="off"
            autoCapitalize="characters"
            dir="ltr"
            className={`${inputClass} h-14 text-2xl`}
          />
        </div>
        <div>
          <label htmlFor="pin" className="mb-1 block text-lg font-medium">
            {t("pin")}
          </label>
          <input
            id="pin"
            name="pin"
            type="password"
            inputMode="numeric"
            pattern="\d{4,6}"
            required
            autoComplete="off"
            dir="ltr"
            className={`${inputClass} h-14 text-2xl tracking-[0.5em]`}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className={`${buttonClass("primary")} h-16 w-full text-xl`}
        >
          {t("clock")}
        </button>
      </form>
    </div>
  );
}

/** The employee's own clock button; sends the location only when the branch asks for it. */
export function PhoneClock({
  action,
  clockedIn,
  needsLocation,
}: {
  action: (input: { latitude?: number; longitude?: number }) => Promise<ActionState>;
  clockedIn: boolean;
  needsLocation: boolean;
}) {
  const t = useTranslations("attendance");
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const send = (input: { latitude?: number; longitude?: number }) =>
    start(async () => {
      const r = await action(input);
      setMessage({ ok: r.ok ?? false, text: (r.ok ? r.message : r.formError) ?? "" });
    });
  const clock = () => {
    setMessage(null);
    if (!needsLocation) return send({});
    if (!("geolocation" in navigator)) return setMessage({ ok: false, text: t("noLocation") });
    navigator.geolocation.getCurrentPosition(
      (pos) => send({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => setMessage({ ok: false, text: t("locationDenied") }),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={clock}
        disabled={pending}
        className={`${buttonClass(clockedIn ? "secondary" : "primary")} h-16 w-full text-xl`}
      >
        {clockedIn ? t("clockOut") : t("clockIn")}
      </button>
      {needsLocation ? <p className="text-muted text-xs">{t("locationNote")}</p> : null}
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={`rounded-lg border px-3 py-2 text-sm ${message.ok ? "border-success/40 bg-success-surface text-success" : "border-danger/40 bg-danger-surface text-danger"}`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

export function PinForm({ action }: { action: Action }) {
  const t = useTranslations("attendance");
  return (
    <ActionForm
      action={action}
      submitLabel={t("setPin")}
      pendingLabel={t("saving")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-3"
    >
      <div className="w-40">
        <TextField
          name="pin"
          type="password"
          label={t("newPin")}
          hint={t("pinHint")}
          inputMode="numeric"
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}

export function ManualPunchForm({ action, today }: { action: Action; today: string }) {
  const t = useTranslations("attendance");
  return (
    <ActionForm
      action={action}
      submitLabel={t("addPunch")}
      pendingLabel={t("saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <SelectField
          name="kind"
          label={t("kind")}
          options={[
            { value: "IN", label: t("kinds.IN") },
            { value: "OUT", label: t("kinds.OUT") },
          ]}
          defaultValue="IN"
          required
        />
        <TextField name="date" type="date" label={t("date")} defaultValue={today} required />
        <TextField name="time" label={t("time")} hint="HH:MM" dir="ltr" required />
        <TextField name="reason" label={t("reason")} required />
      </div>
    </ActionForm>
  );
}

export function VoidPunchForm({ action }: { action: Action }) {
  const t = useTranslations("attendance");
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        className="text-danger text-xs hover:underline"
        onClick={() => setOpen(true)}
      >
        {t("void")}
      </button>
    );
  return (
    <ActionForm
      action={action}
      submitLabel={t("void")}
      pendingLabel={t("saving")}
      submitVariant="danger"
      className="flex items-end gap-2"
    >
      <input
        name="reason"
        required
        aria-label={t("voidReason")}
        placeholder={t("voidReason")}
        className={`${inputClass} w-40`}
      />
    </ActionForm>
  );
}

export function TerminalForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations("attendance");
  return (
    <ActionForm
      action={action}
      submitLabel={t("addTerminal")}
      pendingLabel={t("saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="branchId"
          label={t("branch")}
          options={branches}
          defaultValue={branches.length === 1 ? branches[0].value : ""}
          placeholder="—"
          required
        />
        <TextField name="name" label={t("terminalName")} required />
      </div>
    </ActionForm>
  );
}

export function GeofenceForm({
  action,
  defaults,
}: {
  action: Action;
  defaults?: { latitude: string; longitude: string; radiusMeters: string };
}) {
  const t = useTranslations("attendance");
  return (
    <ActionForm
      action={action}
      submitLabel={t("saveLocation")}
      pendingLabel={t("saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="latitude"
          label={t("latitude")}
          defaultValue={defaults?.latitude}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="longitude"
          label={t("longitude")}
          defaultValue={defaults?.longitude}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="radiusMeters"
          label={t("radius")}
          hint={t("radiusHint")}
          defaultValue={defaults?.radiusMeters ?? "150"}
          inputMode="numeric"
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}

function DeviceCreated() {
  const state = useFormState();
  if (!state.ok || !state.data?.secret) return null;
  return <SecretOnce secret={state.data.secret} endpoint={state.data.endpoint} />;
}

export function DeviceForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations("attendance");
  return (
    <ActionForm action={action} submitLabel={t("addDevice")} pendingLabel={t("saving")} idempotent>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="branchId"
          label={t("branch")}
          options={branches}
          defaultValue={branches.length === 1 ? branches[0].value : ""}
          placeholder="—"
          required
        />
        <TextField name="name" label={t("deviceName")} required />
      </div>
      <DeviceCreated />
    </ActionForm>
  );
}
