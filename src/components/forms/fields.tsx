"use client";

import { createContext, use, useActionState, useRef, useId, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, inputClass, type ButtonVariant } from "@/components/ui/styles";
import { initialActionState, type ActionState } from "./action-state";

type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const FormStateContext = createContext<ActionState>(initialActionState);

/**
 * Form bound to a server action. Shows the localized form error, provides the
 * state to field components, and sends an idempotency key that stays the same
 * for retries of one submission and changes after a success.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  idempotent = false,
  className = "space-y-4",
  submitVariant = "primary",
  hideSubmit = false,
}: {
  action: FormAction;
  children: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  idempotent?: boolean;
  className?: string;
  submitVariant?: ButtonVariant;
  hideSubmit?: boolean;
}) {
  // One key per logical submission: reused when retrying after an error,
  // discarded after success, so a double submit cannot create duplicates.
  const idempotencyKey = useRef<string | null>(null);
  const submit = async (previous: ActionState, formData: FormData) => {
    if (idempotent) {
      idempotencyKey.current ??= crypto.randomUUID();
      formData.set("idempotencyKey", idempotencyKey.current);
    }
    const result = await action(previous, formData);
    if (result.ok) idempotencyKey.current = null;
    return result;
  };
  const [state, formAction] = useActionState(submit, initialActionState);

  return (
    <FormStateContext value={state}>
      <form action={formAction} className={className} noValidate>
        {state.formError ? (
          <p
            role="alert"
            className="border-danger/40 bg-danger-surface text-danger rounded-md border px-3 py-2 text-sm"
          >
            {state.formError}
          </p>
        ) : null}
        {state.ok && state.message ? (
          <p
            role="status"
            className="border-success/40 bg-success-surface text-success rounded-md border px-3 py-2 text-sm"
          >
            {state.message}
          </p>
        ) : null}
        {children}
        {hideSubmit ? null : (
          <SubmitButton label={submitLabel} pendingLabel={pendingLabel} variant={submitVariant} />
        )}
      </form>
    </FormStateContext>
  );
}

export function useFormState(): ActionState {
  return use(FormStateContext);
}

/** Disabled while pending, which also prevents accidental double submission. */
export function SubmitButton({
  label,
  pendingLabel,
  variant = "primary",
}: {
  label: string;
  pendingLabel?: string;
  variant?: ButtonVariant;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={buttonClass(variant)} disabled={pending} aria-busy={pending}>
      {pending ? (pendingLabel ?? label) : label}
    </button>
  );
}

function FieldShell({
  id,
  label,
  hint,
  error,
  optionalLabel,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optionalLabel?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
        {optionalLabel ? (
          <span className="text-muted ms-1 font-normal">({optionalLabel})</span>
        ) : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-muted mt-1 text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-danger mt-1 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface BaseFieldProps {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  required?: boolean;
  optionalLabel?: string;
}

export function TextField({
  type = "text",
  autoComplete,
  dir,
  ...props
}: BaseFieldProps & {
  type?: "text" | "email" | "password";
  autoComplete?: string;
  dir?: "ltr" | "rtl" | "auto";
}) {
  const state = useFormState();
  const id = useId();
  const error = state.fieldErrors?.[props.name];
  const value =
    type === "password" ? undefined : (state.values?.[props.name] ?? props.defaultValue ?? "");
  return (
    <FieldShell
      id={id}
      label={props.label}
      hint={props.hint}
      error={error}
      optionalLabel={props.optionalLabel}
    >
      <input
        id={id}
        key={`${state.seq ?? 0}-${value}`}
        name={props.name}
        type={type}
        defaultValue={value}
        required={props.required}
        autoComplete={autoComplete}
        dir={dir}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : props.hint ? `${id}-hint` : undefined}
        className={inputClass}
      />
    </FieldShell>
  );
}

export function SelectField({
  options,
  placeholder,
  ...props
}: BaseFieldProps & { options: Array<{ value: string; label: string }>; placeholder?: string }) {
  const state = useFormState();
  const id = useId();
  const error = state.fieldErrors?.[props.name];
  const value = state.values?.[props.name] ?? props.defaultValue ?? "";
  return (
    <FieldShell
      id={id}
      label={props.label}
      hint={props.hint}
      error={error}
      optionalLabel={props.optionalLabel}
    >
      <select
        id={id}
        key={`${state.seq ?? 0}-${value}`}
        name={props.name}
        defaultValue={value}
        required={props.required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : props.hint ? `${id}-hint` : undefined}
        className={inputClass}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckboxGroup({
  name,
  legend,
  options,
  defaultValues = [],
  disabled = false,
}: {
  name: string;
  legend: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  defaultValues?: string[];
  disabled?: boolean;
}) {
  const state = useFormState();
  const error = state.fieldErrors?.[name];
  return (
    <fieldset aria-invalid={error ? true : undefined}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className="border-border flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <input
              type="checkbox"
              name={name}
              value={o.value}
              defaultChecked={defaultValues.includes(o.value)}
              disabled={disabled}
              className="mt-0.5"
            />
            <span>
              {o.label}
              {o.hint ? <span className="ltr-value text-muted block text-xs">{o.hint}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {error ? <p className="text-danger mt-1 text-xs">{error}</p> : null}
    </fieldset>
  );
}

/** Read-only value with a copy button (invitation links). */
export function CopyField({
  value,
  label,
  copyLabel,
  copiedLabel,
}: {
  value: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          dir="ltr"
          className={inputClass}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className={buttonClass("secondary")}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
    </div>
  );
}
