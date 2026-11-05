"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

const ADDITIONS = ["OVERTIME", "BONUS", "COMMISSION", "OTHER_ADDITION"] as const;
const DEDUCTIONS = ["ADVANCE_RECOVERY", "INCOME_TAX", "PENALTY", "OTHER_DEDUCTION"] as const;

export function ProrationForm({ action, current }: { action: Action; current: string | null }) {
  const t = useTranslations("payroll");
  const tc = useTranslations("common");
  return (
    <ActionForm action={action} submitLabel={tc("save")} pendingLabel={tc("saving")}>
      <SelectField
        name="prorationBasis"
        label={t("prorationBasis")}
        hint={t("prorationHint")}
        defaultValue={current ?? ""}
        placeholder={t("choose")}
        options={["CALENDAR_DAYS", "THIRTY_DAYS"].map((b) => ({
          value: b,
          label: t(`bases.${b}`),
        }))}
      />
    </ActionForm>
  );
}

export function NewRunForm({ action, companies }: { action: Action; companies: Option[] }) {
  const t = useTranslations("payroll");
  return (
    <ActionForm action={action} submitLabel={t("createRun")} pendingLabel={t("working")} idempotent>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="companyId" label={t("company")} options={companies} />
        <TextField name="period" label={t("period")} hint={t("periodHint")} dir="ltr" required />
      </div>
    </ActionForm>
  );
}

export function AdjustmentForm({ action, employees }: { action: Action; employees: Option[] }) {
  const t = useTranslations("payroll");
  return (
    <ActionForm action={action} submitLabel={t("addAdjustment")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="employeeId" label={t("employee")} options={employees} />
        <SelectField
          name="kind"
          label={t("kind")}
          options={["ADDITION", "DEDUCTION"].map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
        />
        <SelectField
          name="category"
          label={t("category")}
          hint={t("categoryHint")}
          options={[...ADDITIONS, ...DEDUCTIONS].map((c) => ({
            value: c,
            label: t(`categories.${c}`),
          }))}
        />
        <TextField name="amount" label={t("amount")} inputMode="decimal" dir="ltr" required />
      </div>
      <TextField name="note" label={t("note")} />
    </ActionForm>
  );
}

export function PaidForm({ action, today }: { action: Action; today: string }) {
  const t = useTranslations("payroll");
  return (
    <ActionForm action={action} submitLabel={t("markPaid")} pendingLabel={t("working")}>
      <TextField name="paidOn" type="date" label={t("paidOn")} defaultValue={today} required />
    </ActionForm>
  );
}

export function CancelRunForm({ action }: { action: Action }) {
  const t = useTranslations("payroll");
  return (
    <ActionForm
      action={action}
      submitLabel={t("cancelRun")}
      pendingLabel={t("working")}
      submitVariant="danger"
    >
      <TextField name="reason" label={t("cancelReason")} required />
    </ActionForm>
  );
}

export function RuleForm({ action, companies }: { action: Action; companies: Option[] }) {
  const t = useTranslations("payroll");
  return (
    <ActionForm action={action} submitLabel={t("addRule")} pendingLabel={t("working")}>
      <p className="text-muted text-sm">{t("ruleIntro")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="companyId" label={t("company")} options={companies} />
        <SelectField
          name="appliesTo"
          label={t("appliesTo")}
          options={["ALL", "NATIONALS", "NON_NATIONALS"].map((a) => ({
            value: a,
            label: t(`applies.${a}`),
          }))}
        />
        <TextField name="code" label={t("ruleCode")} hint={t("ruleCodeHint")} dir="ltr" required />
        <TextField name="name" label={t("ruleName")} required />
        <TextField
          name="employeeRatePercent"
          label={t("employeeRate")}
          inputMode="decimal"
          dir="ltr"
          defaultValue="0"
        />
        <TextField
          name="employerRatePercent"
          label={t("employerRate")}
          inputMode="decimal"
          dir="ltr"
          defaultValue="0"
        />
        <TextField name="baseMin" label={t("baseMin")} inputMode="decimal" dir="ltr" />
        <TextField name="baseMax" label={t("baseMax")} inputMode="decimal" dir="ltr" />
        <TextField name="effectiveFrom" type="date" label={t("effectiveFrom")} required />
        <TextField name="source" label={t("source")} hint={t("sourceHint")} required />
      </div>
    </ActionForm>
  );
}

export function EndRuleForm({ action }: { action: Action }) {
  const t = useTranslations("payroll");
  return (
    <ActionForm
      action={action}
      submitLabel={t("endRule")}
      pendingLabel={t("working")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <TextField name="effectiveTo" type="date" label={t("effectiveTo")} required />
    </ActionForm>
  );
}

export function SalaryForm({ action }: { action: Action }) {
  const t = useTranslations("payroll");
  return (
    <ActionForm action={action} submitLabel={t("saveSalary")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="effectiveFrom" type="date" label={t("effectiveFrom")} required />
        <TextField name="basic" label={t("basic")} inputMode="decimal" dir="ltr" required />
        <SelectField
          name="payMethod"
          label={t("payMethod")}
          options={["BANK", "CASH"].map((m) => ({ value: m, label: t(`methods.${m}`) }))}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("allowances")}</legend>
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid items-end gap-3 sm:grid-cols-4">
            <TextField name={`items.${i}.code`} label={t("itemCode")} dir="ltr" />
            <TextField name={`items.${i}.name`} label={t("itemName")} />
            <TextField
              name={`items.${i}.amount`}
              label={t("amount")}
              inputMode="decimal"
              dir="ltr"
            />
            <CheckboxField name={`items.${i}.inContributionBase`} label={t("inBase")} />
          </div>
        ))}
      </fieldset>
      <TextField name="note" label={t("note")} />
    </ActionForm>
  );
}

export function BankForm({ action }: { action: Action }) {
  const t = useTranslations("payroll");
  return (
    <ActionForm action={action} submitLabel={t("saveBank")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="bankName" label={t("bankName")} required />
        <TextField name="iban" label="IBAN" dir="ltr" autoComplete="off" required />
      </div>
    </ActionForm>
  );
}
