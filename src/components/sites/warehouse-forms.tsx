"use client";

import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function WarehouseForm({
  action,
  labels,
  types,
  branches,
  defaults = {},
  idempotent = false,
}: {
  action: Action;
  labels: {
    submit: string;
    pending: string;
    code: string;
    name: string;
    type: string;
    branch: string;
  };
  types: Option[];
  /** Omitted when editing: a warehouse cannot change branch. */
  branches?: Option[];
  defaults?: Record<string, string | undefined>;
  idempotent?: boolean;
}) {
  return (
    <ActionForm
      action={action}
      submitLabel={labels.submit}
      pendingLabel={labels.pending}
      idempotent={idempotent}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {branches ? (
          <SelectField
            name="branchId"
            label={labels.branch}
            options={branches}
            defaultValue={defaults.branchId ?? branches[0]?.value}
            required
          />
        ) : null}
        <TextField
          name="code"
          label={labels.code}
          defaultValue={defaults.code}
          dir="ltr"
          required
        />
        <TextField name="name" label={labels.name} defaultValue={defaults.name} required />
        <SelectField
          name="type"
          label={labels.type}
          options={types}
          defaultValue={defaults.type ?? types[0]?.value}
          required
        />
      </div>
    </ActionForm>
  );
}

export function LocationForm({
  action,
  labels,
  zones,
  defaults = {},
  idempotent = false,
}: {
  action: Action;
  labels: { submit: string; pending: string; code: string; name: string; zone: string };
  zones: Option[];
  defaults?: Record<string, string | undefined>;
  idempotent?: boolean;
}) {
  return (
    <ActionForm
      action={action}
      submitLabel={labels.submit}
      pendingLabel={labels.pending}
      idempotent={idempotent}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="code"
          label={labels.code}
          defaultValue={defaults.code}
          dir="ltr"
          required
        />
        <TextField name="name" label={labels.name} defaultValue={defaults.name} required />
        <SelectField
          name="temperatureZone"
          label={labels.zone}
          options={zones}
          defaultValue={defaults.temperatureZone ?? zones[0]?.value}
          required
        />
      </div>
    </ActionForm>
  );
}
