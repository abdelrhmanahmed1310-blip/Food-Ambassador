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
  kind: "REPLENISHMENT" | "DAILY_CLOSE" | "INVOICE_MATCHING" | "FOOD_SAFETY" | "MENU_MARGIN";
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
    minCreditAmount?: string;
    uninvoicedAfterDays?: number;
    complianceBelowPercent?: number;
    expiringWithinDays?: number;
    effectiveInDays?: number;
    maxOrderAmount?: string;
    maxDailyAmount?: string;
    maxActionsPerRun?: number;
    maxIncreasePercent?: number;
    holdHours?: number;
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
    | "salesDropPercent"
    | "minCreditAmount"
    | "uninvoicedAfterDays"
    | "complianceBelowPercent"
    | "expiringWithinDays"
    | "effectiveInDays"
    | "limitsTitle"
    | "limitsHint"
    | "maxOrderAmount"
    | "maxDailyAmount"
    | "maxActionsPerRun"
    | "maxIncreasePercent"
    | "holdHours",
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
        ) : null}
        {kind === "INVOICE_MATCHING" ? (
          <>
            <TextField
              name="minCreditAmount"
              label={labels.minCreditAmount}
              defaultValue={defaults.minCreditAmount ?? "0"}
              inputMode="decimal"
              dir="ltr"
            />
            <TextField
              name="uninvoicedAfterDays"
              label={labels.uninvoicedAfterDays}
              defaultValue={String(defaults.uninvoicedAfterDays ?? 14)}
              inputMode="numeric"
              dir="ltr"
            />
          </>
        ) : null}
        {kind === "FOOD_SAFETY" ? (
          <>
            <TextField
              name="complianceBelowPercent"
              label={labels.complianceBelowPercent}
              defaultValue={String(defaults.complianceBelowPercent ?? 80)}
              inputMode="decimal"
              dir="ltr"
            />
            <TextField
              name="expiringWithinDays"
              label={labels.expiringWithinDays}
              defaultValue={String(defaults.expiringWithinDays ?? 2)}
              inputMode="numeric"
              dir="ltr"
            />
          </>
        ) : null}
        {kind === "MENU_MARGIN" ? (
          <TextField
            name="effectiveInDays"
            label={labels.effectiveInDays}
            defaultValue={String(defaults.effectiveInDays ?? 1)}
            inputMode="numeric"
            dir="ltr"
          />
        ) : null}
        {kind === "DAILY_CLOSE" ? (
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
        ) : null}
      </div>
      {options.autonomy.some((o) => o.value === "ACT") ? (
        <fieldset className="border-border space-y-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{labels.limitsTitle}</legend>
          <p className="text-muted text-xs">{labels.limitsHint}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {kind === "REPLENISHMENT" ? (
              <>
                <TextField
                  name="maxOrderAmount"
                  label={labels.maxOrderAmount}
                  defaultValue={defaults.maxOrderAmount ?? "0"}
                  inputMode="decimal"
                  dir="ltr"
                />
                <TextField
                  name="maxDailyAmount"
                  label={labels.maxDailyAmount}
                  defaultValue={defaults.maxDailyAmount ?? "0"}
                  inputMode="decimal"
                  dir="ltr"
                />
              </>
            ) : null}
            {kind === "MENU_MARGIN" ? (
              <TextField
                name="maxIncreasePercent"
                label={labels.maxIncreasePercent}
                defaultValue={String(defaults.maxIncreasePercent ?? 5)}
                inputMode="decimal"
                dir="ltr"
              />
            ) : null}
            {kind === "FOOD_SAFETY" || kind === "MENU_MARGIN" ? (
              <TextField
                name="maxActionsPerRun"
                label={labels.maxActionsPerRun}
                defaultValue={String(defaults.maxActionsPerRun ?? 3)}
                inputMode="numeric"
                dir="ltr"
              />
            ) : null}
            <TextField
              name="holdHours"
              label={labels.holdHours}
              defaultValue={String(defaults.holdHours ?? 4)}
              inputMode="numeric"
              dir="ltr"
            />
          </div>
        </fieldset>
      ) : null}
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
      {(kind === "DAILY_CLOSE" || kind === "FOOD_SAFETY") && options.branches.length ? (
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
