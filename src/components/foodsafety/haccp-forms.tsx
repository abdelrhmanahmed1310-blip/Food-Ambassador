"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** A new HACCP plan (ADR-096). */
export function HaccpPlanForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.create")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("haccp.code")} required dir="ltr" />
        <TextField name="name" label={t("haccp.name")} required />
        <SelectField
          name="branchId"
          label={t("haccp.branch")}
          options={branches}
          placeholder={t("haccp.allBranches")}
        />
        <TextField name="team" label={t("haccp.team")} optionalLabel={t("common.optional")} />
        <div className="sm:col-span-2">
          <TextField name="scope" label={t("haccp.scope")} hint={t("haccp.scopeHint")} required />
        </div>
        <div className="sm:col-span-2">
          <TextField
            name="intendedUse"
            label={t("haccp.intendedUse")}
            optionalLabel={t("common.optional")}
          />
        </div>
      </div>
    </ActionForm>
  );
}

export function HaccpStepForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("haccp.addStep")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-3"
    >
      <div className="min-w-56">
        <TextField name="name" label={t("haccp.stepName")} required />
      </div>
      <div className="min-w-64 flex-1">
        <TextField
          name="description"
          label={t("haccp.stepDescription")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

const scores = ["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v }));

/** A hazard with its assessment and the Codex decision-tree answers. */
export function HaccpHazardForm({ action, steps }: { action: Action; steps: Option[] }) {
  const t = useTranslations();
  const yesNo = [
    { value: "yes", label: t("haccp.yes") },
    { value: "no", label: t("haccp.no") },
  ];
  return (
    <ActionForm
      action={action}
      submitLabel={t("haccp.addHazard")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="stepId"
          label={t("haccp.step")}
          options={steps}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="type"
          label={t("haccp.hazardType")}
          required
          options={(["BIOLOGICAL", "CHEMICAL", "PHYSICAL", "ALLERGEN"] as const).map((v) => ({
            value: v,
            label: t(`haccp.hazardTypes.${v}`),
          }))}
          placeholder={t("common.select")}
        />
        <TextField name="description" label={t("haccp.hazard")} required />
        <SelectField
          name="likelihood"
          label={t("haccp.likelihood")}
          options={scores}
          defaultValue="3"
        />
        <SelectField
          name="severity"
          label={t("haccp.severity")}
          options={scores}
          defaultValue="3"
        />
        <TextField
          name="controlMeasures"
          label={t("haccp.controlMeasures")}
          optionalLabel={t("common.optional")}
        />
      </div>
      <CheckboxField name="significant" label={t("haccp.significant")} />
      <fieldset className="border-border rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">{t("haccp.tree")}</legend>
        <p className="text-muted mb-2 text-xs">{t("haccp.treeHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["q1", "q2", "q3", "q4"] as const).map((q) => (
            <SelectField
              key={q}
              name={q}
              label={t(`haccp.questions.${q}`)}
              options={yesNo}
              placeholder="—"
            />
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="classification"
          label={t("haccp.classification")}
          options={(["CCP", "OPRP", "PRP"] as const).map((v) => ({
            value: v,
            label: t(`haccp.classes.${v}`),
          }))}
          placeholder={t("haccp.fromTree")}
        />
        <TextField
          name="justification"
          label={t("haccp.justification")}
          hint={t("haccp.justificationHint")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

/** Critical limits, monitoring, correction and verification of a CCP or OPRP. */
export function HaccpControlPointForm({
  action,
  defaults = {},
}: {
  action: Action;
  defaults?: Partial<Record<string, string>>;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField
            name="criticalLimit"
            label={t("haccp.criticalLimit")}
            defaultValue={defaults.criticalLimit}
            required
          />
        </div>
        <TextField
          name="minValue"
          label={t("haccp.minValue")}
          defaultValue={defaults.minValue}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="maxValue"
          label={t("haccp.maxValue")}
          defaultValue={defaults.maxValue}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="unit"
          label={t("haccp.unit")}
          hint={t("haccp.unitHint")}
          defaultValue={defaults.unit}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="frequency"
          label={t("haccp.frequency")}
          defaultValue={defaults.frequency}
          required
        />
        <TextField
          name="monitoring"
          label={t("haccp.monitoring")}
          defaultValue={defaults.monitoring}
          required
        />
        <TextField
          name="responsible"
          label={t("haccp.responsible")}
          defaultValue={defaults.responsible}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="correctiveAction"
          label={t("haccp.correctiveAction")}
          defaultValue={defaults.correctiveAction}
          required
        />
        <TextField
          name="verification"
          label={t("haccp.verification")}
          defaultValue={defaults.verification}
          required
        />
        <div className="sm:col-span-2">
          <TextField
            name="recordsKept"
            label={t("haccp.recordsKept")}
            defaultValue={defaults.recordsKept}
            optionalLabel={t("common.optional")}
          />
        </div>
      </div>
    </ActionForm>
  );
}

export function LinkCheckpointForm({
  action,
  checkpoints,
}: {
  action: Action;
  checkpoints: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("haccp.link")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-3"
    >
      <div className="min-w-64">
        <SelectField
          name="checkpointId"
          label={t("haccp.monitoredBy")}
          options={checkpoints}
          placeholder={t("common.select")}
          required
        />
      </div>
    </ActionForm>
  );
}

export function ApprovePlanForm({ action, defaultDate }: { action: Action; defaultDate: string }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("haccp.approve")}
      pendingLabel={t("common.saving")}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="w-48">
        <TextField
          name="reviewDueOn"
          type="date"
          label={t("haccp.reviewDueOn")}
          defaultValue={defaultDate}
          required
        />
      </div>
    </ActionForm>
  );
}
