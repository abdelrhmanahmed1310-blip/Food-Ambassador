"use client";

import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import type { ActionState } from "@/components/forms/action-state";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

export interface SignUpLabels {
  submit: string;
  pending: string;
  yourDetails: string;
  name: string;
  email: string;
  password: string;
  passwordHint: string;
  organizationSection: string;
  organizationName: string;
  baseCurrency: string;
  baseCurrencyHint: string;
  timeZone: string;
  select: string;
}

export function SignInForm({
  action,
  next,
  labels,
}: {
  action: Action;
  next?: string;
  labels: { email: string; password: string; submit: string; pending: string };
}) {
  return (
    <ActionForm action={action} submitLabel={labels.submit} pendingLabel={labels.pending}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <TextField
        name="email"
        type="email"
        label={labels.email}
        autoComplete="email"
        dir="ltr"
        required
      />
      <TextField
        name="password"
        type="password"
        label={labels.password}
        autoComplete="current-password"
        dir="ltr"
        required
      />
    </ActionForm>
  );
}

/** Sign-up; with `invite` the organization section is replaced by the invitation. */
export function SignUpForm({
  action,
  labels,
  currencies,
  timeZones,
  invite,
}: {
  action: Action;
  labels: SignUpLabels;
  currencies: Option[];
  timeZones: Option[];
  invite?: { token: string; email: string };
}) {
  return (
    <ActionForm
      action={action}
      submitLabel={labels.submit}
      pendingLabel={labels.pending}
      className="space-y-6"
    >
      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">{labels.yourDetails}</legend>
        <TextField name="name" label={labels.name} autoComplete="name" required />
        <TextField
          name="email"
          type="email"
          label={labels.email}
          autoComplete="email"
          dir="ltr"
          defaultValue={invite?.email}
          required
        />
        <TextField
          name="password"
          type="password"
          label={labels.password}
          hint={labels.passwordHint}
          autoComplete="new-password"
          dir="ltr"
          required
        />
      </fieldset>
      {invite ? (
        <input type="hidden" name="inviteToken" value={invite.token} />
      ) : (
        <OrganizationFields labels={labels} currencies={currencies} timeZones={timeZones} />
      )}
    </ActionForm>
  );
}

export function OrganizationFields({
  labels,
  currencies,
  timeZones,
}: {
  labels: Pick<
    SignUpLabels,
    | "organizationSection"
    | "organizationName"
    | "baseCurrency"
    | "baseCurrencyHint"
    | "timeZone"
    | "select"
  >;
  currencies: Option[];
  timeZones: Option[];
}) {
  return (
    <fieldset className="space-y-4">
      <legend className="mb-2 text-sm font-semibold">{labels.organizationSection}</legend>
      <TextField
        name="organizationName"
        label={labels.organizationName}
        autoComplete="organization"
        required
      />
      <SelectField
        name="baseCurrency"
        label={labels.baseCurrency}
        hint={labels.baseCurrencyHint}
        options={currencies}
        placeholder={labels.select}
        required
      />
      <SelectField
        name="timeZone"
        label={labels.timeZone}
        options={timeZones}
        placeholder={labels.select}
        required
      />
    </fieldset>
  );
}

export function NewOrganizationForm({
  action,
  labels,
  currencies,
  timeZones,
}: {
  action: Action;
  labels: SignUpLabels;
  currencies: Option[];
  timeZones: Option[];
}) {
  return (
    <ActionForm action={action} submitLabel={labels.submit} pendingLabel={labels.pending}>
      <OrganizationFields labels={labels} currencies={currencies} timeZones={timeZones} />
    </ActionForm>
  );
}
