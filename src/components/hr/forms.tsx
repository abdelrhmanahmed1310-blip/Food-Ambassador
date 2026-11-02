"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "TEMPORARY"];
const DOCUMENT_TYPES = [
  "IQAMA",
  "NATIONAL_ID",
  "PASSPORT",
  "WORK_PERMIT",
  "HEALTH_CERTIFICATE",
  "DRIVING_LICENSE",
  "CONTRACT",
  "OTHER",
];

/** New employee or edit (HRIS, ADR-079). */
export function EmployeeForm({
  action,
  branches,
  departments,
  managers,
  members,
  defaults = {},
  submitLabel,
  idempotent = false,
}: {
  action: Action;
  branches: Option[];
  departments: Option[];
  managers: Option[];
  members: Option[];
  defaults?: Record<string, string | null | undefined>;
  submitLabel: string;
  idempotent?: boolean;
}) {
  const t = useTranslations();
  const d = (k: string) => defaults[k] ?? "";
  const optional = t("common.optional");
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      idempotent={idempotent}
    >
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">{t("hr.personal")}</legend>
        <TextField
          name="firstName"
          label={t("hr.firstName")}
          defaultValue={d("firstName")}
          required
        />
        <TextField name="lastName" label={t("hr.lastName")} defaultValue={d("lastName")} required />
        <TextField
          name="nameAr"
          label={t("hr.nameAr")}
          defaultValue={d("nameAr")}
          dir="rtl"
          optionalLabel={optional}
        />
        <TextField
          name="nationality"
          label={t("hr.nationality")}
          hint={t("hr.nationalityHint")}
          defaultValue={d("nationality")}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="nationalId"
          label={t("hr.nationalId")}
          hint={t("hr.nationalIdHint")}
          defaultValue={d("nationalId")}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="email"
          type="email"
          label={t("hr.email")}
          defaultValue={d("email")}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="phone"
          label={t("hr.phone")}
          defaultValue={d("phone")}
          dir="ltr"
          optionalLabel={optional}
        />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">{t("hr.job")}</legend>
        <TextField
          name="number"
          label={t("hr.number")}
          hint={t("hr.numberHint")}
          defaultValue={d("number")}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField name="jobTitle" label={t("hr.jobTitle")} defaultValue={d("jobTitle")} required />
        <SelectField
          name="branchId"
          label={t("hr.branch")}
          options={branches}
          placeholder={t("common.select")}
          defaultValue={d("branchId") || (branches.length === 1 ? branches[0].value : "")}
          required
        />
        <SelectField
          name="departmentId"
          label={t("hr.department")}
          options={departments}
          placeholder="—"
          defaultValue={d("departmentId")}
          optionalLabel={optional}
        />
        <SelectField
          name="managerId"
          label={t("hr.manager")}
          options={managers}
          placeholder="—"
          defaultValue={d("managerId")}
          optionalLabel={optional}
        />
        <SelectField
          name="employmentType"
          label={t("hr.employmentType")}
          options={EMPLOYMENT_TYPES.map((v) => ({ value: v, label: t(`hr.employmentTypes.${v}`) }))}
          defaultValue={d("employmentType") || "FULL_TIME"}
          required
        />
        <TextField
          name="hireDate"
          type="date"
          label={t("hr.hireDate")}
          defaultValue={d("hireDate")}
          required
        />
        <SelectField
          name="userId"
          label={t("hr.account")}
          hint={t("hr.accountHint")}
          options={members}
          placeholder="—"
          defaultValue={d("userId")}
          optionalLabel={optional}
        />
      </fieldset>
    </ActionForm>
  );
}

export function DepartmentForm({ action, parents }: { action: Action; parents: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("hr.addDepartment")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("hr.code")} dir="ltr" required />
        <TextField name="name" label={t("hr.departmentName")} required />
        <TextField
          name="nameAr"
          label={t("hr.nameAr")}
          dir="rtl"
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="parentId"
          label={t("hr.parentDepartment")}
          options={parents}
          placeholder="—"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function DocumentForm({ action }: { action: Action }) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm action={action} submitLabel={t("hr.addDocument")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="type"
          label={t("hr.documentType")}
          options={DOCUMENT_TYPES.map((v) => ({ value: v, label: t(`hr.documentTypes.${v}`) }))}
          defaultValue="IQAMA"
          required
        />
        <TextField
          name="number"
          label={t("hr.documentNumber")}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField name="issuedOn" type="date" label={t("hr.issuedOn")} optionalLabel={optional} />
        <TextField
          name="expiresOn"
          type="date"
          label={t("hr.expiresOn")}
          optionalLabel={optional}
        />
      </div>
    </ActionForm>
  );
}

/** On leave, active again, or terminated with a date and reason. */
export function StatusForm({ action, current }: { action: Action; current: string }) {
  const t = useTranslations();
  const choices = ["ACTIVE", "ON_LEAVE", "TERMINATED"].filter((s) => s !== current);
  const [status, setStatus] = useState(choices[0]);
  return (
    <ActionForm
      action={action}
      submitLabel={t("hr.changeStatus")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="hr-status" className="mb-1 block text-sm font-medium">
            {t("hr.newStatus")}
          </label>
          <select
            id="hr-status"
            name="status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="border-border bg-surface block w-full rounded-lg border px-3 py-2 text-sm"
          >
            {choices.map((s) => (
              <option key={s} value={s}>
                {t(`hr.statuses.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {status === "TERMINATED" ? (
          <>
            <TextField name="terminatedOn" type="date" label={t("hr.terminatedOn")} required />
            <TextField name="reason" label={t("hr.terminationReason")} required />
          </>
        ) : null}
      </div>
    </ActionForm>
  );
}
