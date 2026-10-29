"use client";

import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };

export interface BranchFormLabels {
  submit: string;
  pending: string;
  code: string;
  codeHint: string;
  name: string;
  type: string;
  timeZone: string;
  timeZoneHint: string;
  address: string;
  city: string;
  country: string;
  countryHint: string;
  optional: string;
}

export function BranchForm({
  action,
  labels,
  types,
  timeZones,
  defaults = {},
  idempotent = false,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  labels: BranchFormLabels;
  types: Option[];
  timeZones: Option[];
  defaults?: Record<string, string | null | undefined>;
  idempotent?: boolean;
}) {
  const d = (k: string) => defaults[k] ?? "";
  return (
    <ActionForm
      action={action}
      submitLabel={labels.submit}
      pendingLabel={labels.pending}
      idempotent={idempotent}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="code"
          label={labels.code}
          hint={labels.codeHint}
          defaultValue={d("code")}
          dir="ltr"
          required
        />
        <TextField name="name" label={labels.name} defaultValue={d("name")} required />
        <SelectField
          name="type"
          label={labels.type}
          options={types}
          defaultValue={d("type") || types[0]?.value}
          required
        />
        <SelectField
          name="timeZone"
          label={labels.timeZone}
          hint={labels.timeZoneHint}
          options={timeZones}
          placeholder="—"
          defaultValue={d("timeZone")}
          optionalLabel={labels.optional}
        />
        <TextField
          name="addressLine"
          label={labels.address}
          defaultValue={d("addressLine")}
          optionalLabel={labels.optional}
        />
        <TextField
          name="city"
          label={labels.city}
          defaultValue={d("city")}
          optionalLabel={labels.optional}
        />
        <TextField
          name="country"
          label={labels.country}
          hint={labels.countryHint}
          defaultValue={d("country")}
          dir="ltr"
          optionalLabel={labels.optional}
        />
      </div>
    </ActionForm>
  );
}
