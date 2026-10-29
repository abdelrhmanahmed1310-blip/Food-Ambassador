"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, type ButtonVariant } from "@/components/ui/styles";
import { initialActionState, type ActionState } from "./action-state";

function Submit({
  label,
  variant,
  confirmMessage,
}: {
  label: string;
  variant: ButtonVariant;
  confirmMessage?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={buttonClass(variant)}
      onClick={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {label}
    </button>
  );
}

/**
 * One-button form for irreversible or destructive actions (archive, revoke,
 * remove). Asks for confirmation and shows the localized error inline.
 */
export function ConfirmActionButton({
  action,
  label,
  confirmMessage,
  variant = "danger",
  hidden = {},
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  confirmMessage?: string;
  variant?: ButtonVariant;
  hidden?: Record<string, string>;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Submit label={label} variant={variant} confirmMessage={confirmMessage} />
      {state.formError ? (
        <span role="alert" className="text-danger text-xs">
          {state.formError}
        </span>
      ) : null}
    </form>
  );
}
