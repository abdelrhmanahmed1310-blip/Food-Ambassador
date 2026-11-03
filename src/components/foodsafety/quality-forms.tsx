"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const AUDIT_TYPES = ["INTERNAL", "EXTERNAL", "AUTHORITY", "CUSTOMER"] as const;
const SEVERITIES = ["OBSERVATION", "MINOR", "MAJOR", "CRITICAL"] as const;
const CHANNELS = [
  "IN_PERSON",
  "PHONE",
  "EMAIL",
  "ONLINE",
  "DELIVERY_PLATFORM",
  "SOCIAL_MEDIA",
  "OTHER",
] as const;
const CATEGORIES = [
  "FOREIGN_OBJECT",
  "ILLNESS",
  "ALLERGEN",
  "QUALITY",
  "TEMPERATURE",
  "HYGIENE",
  "SERVICE",
  "OTHER",
] as const;

/** Plan an audit or inspection (ADR-098). */
export function PlanAuditForm({
  action,
  branches,
  today,
}: {
  action: Action;
  branches: Option[];
  today: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("audits.plan")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="branchId"
          label={t("audits.branch")}
          options={branches}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="type"
          label={t("audits.type")}
          options={AUDIT_TYPES.map((v) => ({ value: v, label: t(`audits.types.${v}`) }))}
          placeholder={t("common.select")}
          required
        />
        <TextField name="auditor" label={t("audits.auditor")} required />
        <TextField
          name="plannedOn"
          type="date"
          label={t("audits.plannedOn")}
          defaultValue={today}
          required
        />
        <div className="sm:col-span-2">
          <TextField name="scope" label={t("audits.scope")} required />
        </div>
      </div>
    </ActionForm>
  );
}

export function FindingForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("audits.addFinding")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          name="severity"
          label={t("audits.severity")}
          options={SEVERITIES.map((v) => ({ value: v, label: t(`audits.severities.${v}`) }))}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="reference"
          label={t("audits.reference")}
          optionalLabel={t("common.optional")}
        />
        <TextField name="description" label={t("audits.finding")} required />
      </div>
      <p className="text-muted text-xs">{t("audits.findingHint")}</p>
    </ActionForm>
  );
}

export function CompleteAuditForm({ action, today }: { action: Action; today: string }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("audits.complete")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="conductedOn"
          type="date"
          label={t("audits.conductedOn")}
          defaultValue={today}
          required
        />
        <TextField
          name="result"
          label={t("audits.result")}
          hint={t("audits.resultHint")}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="summary"
          label={t("audits.summary")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

/** Log a customer complaint. Foreign objects, illness and allergens open a non-conformance. */
export function ComplaintForm({
  action,
  branches,
  products,
  today,
}: {
  action: Action;
  branches: Option[];
  products: Option[];
  today: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("complaints.log")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="branchId"
          label={t("complaints.branch")}
          options={branches}
          defaultValue={branches.length === 1 ? branches[0].value : undefined}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="receivedOn"
          type="date"
          label={t("complaints.receivedOn")}
          defaultValue={today}
          required
        />
        <SelectField
          name="channel"
          label={t("complaints.channel")}
          options={CHANNELS.map((v) => ({ value: v, label: t(`complaints.channels.${v}`) }))}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="category"
          label={t("complaints.category")}
          options={CATEGORIES.map((v) => ({ value: v, label: t(`complaints.categories.${v}`) }))}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="productId"
          label={t("complaints.product")}
          options={products}
          placeholder="—"
        />
        <TextField
          name="lotCode"
          label={t("complaints.lot")}
          optionalLabel={t("common.optional")}
          dir="ltr"
        />
        <TextField
          name="orderReference"
          label={t("complaints.orderReference")}
          optionalLabel={t("common.optional")}
          dir="ltr"
        />
        <TextField
          name="customerName"
          label={t("complaints.customerName")}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="customerContact"
          label={t("complaints.customerContact")}
          optionalLabel={t("common.optional")}
          dir="ltr"
        />
        <div className="sm:col-span-3">
          <TextField name="description" label={t("complaints.description")} required />
        </div>
      </div>
      <p className="text-muted text-xs">{t("complaints.safetyHint")}</p>
    </ActionForm>
  );
}

export function TextActionForm({
  action,
  name,
  label,
  submitLabel,
  extra,
}: {
  action: Action;
  name: string;
  label: string;
  submitLabel: string;
  extra?: { name: string; label: string };
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <TextField name={name} label={label} required />
      {extra ? (
        <TextField name={extra.name} label={extra.label} optionalLabel={t("common.optional")} />
      ) : null}
    </ActionForm>
  );
}
