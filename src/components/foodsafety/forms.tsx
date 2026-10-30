"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const RECORD_TYPES = ["TEMPERATURE", "HYGIENE", "CLEANING", "PEST_CONTROL", "OTHER"] as const;
const KINDS = ["FRIDGE", "FREEZER", "HOT_HOLDING", "COOKING", "AMBIENT", "OTHER"] as const;
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export function RecordForm({
  action,
  checkpoints,
  branches,
}: {
  action: Action;
  checkpoints: Option[];
  branches: Option[];
}) {
  const t = useTranslations();
  const [type, setType] = useState<string>("TEMPERATURE");
  return (
    <ActionForm
      action={action}
      submitLabel={t("foodSafety.record")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t("foodSafety.recordType")}</span>
          <select
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="border-border bg-surface w-full rounded-md border px-3 py-2"
          >
            {RECORD_TYPES.map((r) => (
              <option key={r} value={r}>
                {t(`foodSafety.recordTypes.${r}`)}
              </option>
            ))}
          </select>
        </label>
        {type === "TEMPERATURE" ? (
          <>
            <SelectField
              name="checkpointId"
              label={t("foodSafety.checkpoint")}
              options={checkpoints}
              placeholder={t("common.select")}
              required
            />
            <TextField
              name="valueCelsius"
              label={t("foodSafety.reading")}
              inputMode="decimal"
              dir="ltr"
              required
            />
          </>
        ) : (
          <>
            <SelectField
              name="branchId"
              label={t("foodSafety.branch")}
              options={branches}
              placeholder={t("common.select")}
              required
            />
            <SelectField
              name="passed"
              label={t("foodSafety.result")}
              options={[
                { value: "yes", label: t("foodSafety.pass") },
                { value: "no", label: t("foodSafety.fail") },
              ]}
              placeholder={t("common.select")}
              required
            />
          </>
        )}
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
        <div className="sm:col-span-2">
          <TextField
            name="correctiveNote"
            label={t("foodSafety.correctiveNote")}
            hint={t("foodSafety.correctiveHint")}
            optionalLabel={t("common.optional")}
          />
        </div>
      </div>
    </ActionForm>
  );
}

export function CheckpointForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.create")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="branchId"
          label={t("foodSafety.branch")}
          options={branches}
          placeholder={t("common.select")}
          required
        />
        <TextField name="code" label={t("foodSafety.code")} dir="ltr" required />
        <TextField name="name" label={t("foodSafety.name")} required />
        <SelectField
          name="kind"
          label={t("foodSafety.kind")}
          options={KINDS.map((k) => ({ value: k, label: t(`foodSafety.kinds.${k}`) }))}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="minCelsius"
          label={t("foodSafety.minCelsius")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="maxCelsius"
          label={t("foodSafety.maxCelsius")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function TemplateForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.create")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label={t("foodSafety.name")} required />
        <TextField
          name="description"
          label={t("recipes.description")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function ItemForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("foodSafety.addItem")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <TextField name="text" label={t("foodSafety.itemText")} required />
        </div>
        <SelectField
          name="kind"
          label={t("foodSafety.answerKind")}
          options={[
            { value: "YES_NO", label: t("foodSafety.answerKinds.YES_NO") },
            { value: "NUMBER", label: t("foodSafety.answerKinds.NUMBER") },
          ]}
          placeholder={t("common.select")}
          required
        />
        <div className="grid grid-cols-2 gap-2">
          <TextField
            name="minValue"
            label={t("foodSafety.min")}
            inputMode="decimal"
            dir="ltr"
            optionalLabel={t("common.optional")}
          />
          <TextField
            name="maxValue"
            label={t("foodSafety.max")}
            inputMode="decimal"
            dir="ltr"
            optionalLabel={t("common.optional")}
          />
        </div>
      </div>
    </ActionForm>
  );
}

export interface RunItem {
  id: string;
  text: string;
  kind: "YES_NO" | "NUMBER";
  range: string | null;
}

export function RunForm({
  action,
  branches,
  items,
}: {
  action: Action;
  branches: Option[];
  items: RunItem[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("foodSafety.completeChecklist")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <SelectField
        name="branchId"
        label={t("foodSafety.branch")}
        options={branches}
        placeholder={t("common.select")}
        defaultValue={branches.length === 1 ? branches[0].value : undefined}
        required
      />
      {items.map((item, i) => (
        <fieldset key={item.id} className="border-border rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">{item.text}</legend>
          <input type="hidden" name={`answers.${i}.itemId`} value={item.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            {item.kind === "YES_NO" ? (
              <SelectField
                name={`answers.${i}.yes`}
                label={t("foodSafety.answer")}
                options={[
                  { value: "yes", label: t("common.yes") },
                  { value: "no", label: t("common.no") },
                ]}
                placeholder={t("common.select")}
                required
              />
            ) : (
              <TextField
                name={`answers.${i}.value`}
                label={t("foodSafety.answer")}
                hint={item.range ?? undefined}
                inputMode="decimal"
                dir="ltr"
                required
              />
            )}
            <TextField
              name={`answers.${i}.note`}
              label={t("common.note")}
              optionalLabel={t("common.optional")}
            />
          </div>
        </fieldset>
      ))}
      <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
    </ActionForm>
  );
}

export function NcForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("foodSafety.raise")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="branchId"
          label={t("foodSafety.branch")}
          options={branches}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="severity"
          label={t("foodSafety.severity")}
          options={SEVERITIES.map((s) => ({ value: s, label: t(`foodSafety.severities.${s}`) }))}
          placeholder={t("common.select")}
          required
        />
        <div className="sm:col-span-2">
          <TextField name="title" label={t("foodSafety.ncTitle")} required />
        </div>
        <div className="sm:col-span-2">
          <TextField name="description" label={t("foodSafety.description")} required />
        </div>
      </div>
    </ActionForm>
  );
}

export function SingleTextForm({
  action,
  name,
  label,
  submitLabel,
  variant = "secondary",
}: {
  action: Action;
  name: string;
  label: string;
  submitLabel: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      submitVariant={variant}
    >
      <TextField name={name} label={label} required />
    </ActionForm>
  );
}

export function CorrectiveActionForm({ action, members }: { action: Action; members: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("foodSafety.addAction")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <TextField name="description" label={t("foodSafety.actionDescription")} required />
        </div>
        <SelectField
          name="ownerUserId"
          label={t("foodSafety.owner")}
          options={members}
          placeholder="—"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="dueOn"
          type="date"
          label={t("foodSafety.dueOn")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}
