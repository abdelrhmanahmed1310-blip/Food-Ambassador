"use client";

import {
  ActionForm,
  CheckboxField,
  CheckboxGroup,
  SelectField,
  TextField,
} from "@/components/forms/fields";
import type { ActionState } from "@/components/forms/action-state";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

/** One agent's settings (ADR-140): on/off, how far it may go, when it runs, what it covers. */
export function AgentForm({
  action,
  kind,
  defaults,
  options,
  labels,
}: {
  action: Action;
  kind: "REPLENISHMENT" | "DAILY_CLOSE";
  defaults: {
    enabled: boolean;
    autonomy: string;
    runHour: number;
    warehouseIds?: string[];
    basis?: string;
    branchIds?: string[];
    cashTolerance?: string;
    voidAlertPercent?: number;
    salesDropPercent?: number;
  };
  options: {
    autonomy: Option[];
    hours: Option[];
    warehouses: Option[];
    branches: Option[];
    bases: Option[];
  };
  labels: Record<
    | "save"
    | "saving"
    | "enabled"
    | "autonomy"
    | "runHour"
    | "warehouses"
    | "warehousesHint"
    | "basis"
    | "branches"
    | "branchesHint"
    | "cashTolerance"
    | "voidAlertPercent"
    | "salesDropPercent",
    string
  >;
}) {
  return (
    <ActionForm action={action} submitLabel={labels.save} pendingLabel={labels.saving}>
      <CheckboxField name="enabled" label={labels.enabled} defaultChecked={defaults.enabled} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="autonomy"
          label={labels.autonomy}
          options={options.autonomy}
          defaultValue={defaults.autonomy}
          required
        />
        <SelectField
          name="runHour"
          label={labels.runHour}
          options={options.hours}
          defaultValue={String(defaults.runHour)}
          required
        />
        {kind === "REPLENISHMENT" ? (
          <SelectField
            name="basis"
            label={labels.basis}
            options={options.bases}
            defaultValue={defaults.basis}
          />
        ) : (
          <>
            <TextField
              name="cashTolerance"
              label={labels.cashTolerance}
              defaultValue={defaults.cashTolerance}
              inputMode="decimal"
              dir="ltr"
            />
            <TextField
              name="voidAlertPercent"
              label={labels.voidAlertPercent}
              defaultValue={String(defaults.voidAlertPercent ?? 5)}
              inputMode="decimal"
              dir="ltr"
            />
            <TextField
              name="salesDropPercent"
              label={labels.salesDropPercent}
              defaultValue={String(defaults.salesDropPercent ?? 30)}
              inputMode="decimal"
              dir="ltr"
            />
          </>
        )}
      </div>
      {kind === "REPLENISHMENT" && options.warehouses.length ? (
        <div>
          <CheckboxGroup
            name="warehouseIds"
            legend={labels.warehouses}
            options={options.warehouses}
            defaultValues={defaults.warehouseIds}
          />
          <p className="text-muted mt-1 text-xs">{labels.warehousesHint}</p>
        </div>
      ) : null}
      {kind === "DAILY_CLOSE" && options.branches.length ? (
        <div>
          <CheckboxGroup
            name="branchIds"
            legend={labels.branches}
            options={options.branches}
            defaultValues={defaults.branchIds}
          />
          <p className="text-muted mt-1 text-xs">{labels.branchesHint}</p>
        </div>
      ) : null}
    </ActionForm>
  );
}
