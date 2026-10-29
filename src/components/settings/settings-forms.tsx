"use client";

import { useActionState, useState } from "react";
import type { ActionState } from "@/components/forms/action-state";
import { initialActionState } from "@/components/forms/action-state";
import {
  ActionForm,
  FormStateContext,
  CheckboxGroup,
  CopyField,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/forms/fields";
import { inputClass } from "@/components/ui/styles";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function OrganizationForm({
  action,
  labels,
  timeZones,
  locales,
  defaults,
}: {
  action: Action;
  labels: {
    submit: string;
    pending: string;
    name: string;
    timeZone: string;
    defaultLocale: string;
  };
  timeZones: Option[];
  locales: Option[];
  defaults: { name: string; timeZone: string; defaultLocale: string };
}) {
  return (
    <ActionForm action={action} submitLabel={labels.submit} pendingLabel={labels.pending}>
      <TextField name="name" label={labels.name} defaultValue={defaults.name} required />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="timeZone"
          label={labels.timeZone}
          options={timeZones}
          defaultValue={defaults.timeZone}
          required
        />
        <SelectField
          name="defaultLocale"
          label={labels.defaultLocale}
          options={locales}
          defaultValue={defaults.defaultLocale}
          required
        />
      </div>
    </ActionForm>
  );
}

export interface RoleScopeLabels {
  role: string;
  scope: string;
  branch: string;
  warehouse: string;
  scopeTypes: Record<"ORGANIZATION" | "BRANCH" | "WAREHOUSE", string>;
}

/** Role + scope pickers; the branch/warehouse select appears only for that scope. */
function RoleScopeFields({
  labels,
  roles,
  branches,
  warehouses,
}: {
  labels: RoleScopeLabels;
  roles: Option[];
  branches: Option[];
  warehouses: Option[];
}) {
  const [scope, setScope] = useState("ORGANIZATION");
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {/* No default: granting a role (especially Owner) must be an explicit choice. */}
      <SelectField name="roleId" label={labels.role} options={roles} placeholder="—" required />
      <div>
        <label htmlFor="scopeType" className="mb-1 block text-sm font-medium">
          {labels.scope}
        </label>
        <select
          id="scopeType"
          name="scopeType"
          className={inputClass}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          {(["ORGANIZATION", "BRANCH", "WAREHOUSE"] as const).map((s) => (
            <option
              key={s}
              value={s}
              disabled={
                (s === "BRANCH" && branches.length === 0) ||
                (s === "WAREHOUSE" && warehouses.length === 0)
              }
            >
              {labels.scopeTypes[s]}
            </option>
          ))}
        </select>
      </div>
      {scope === "BRANCH" ? (
        <SelectField
          name="branchId"
          label={labels.branch}
          options={branches}
          defaultValue={branches[0]?.value}
          required
        />
      ) : null}
      {scope === "WAREHOUSE" ? (
        <SelectField
          name="warehouseId"
          label={labels.warehouse}
          options={warehouses}
          defaultValue={warehouses[0]?.value}
          required
        />
      ) : null}
    </div>
  );
}

/** Invitation form; on success shows the one-time invitation link to copy. */
export function InviteForm({
  action,
  labels,
  roles,
  branches,
  warehouses,
}: {
  action: Action;
  labels: RoleScopeLabels & {
    submit: string;
    pending: string;
    email: string;
    link: string;
    linkHint: string;
    copy: string;
    copied: string;
  };
  roles: Option[];
  branches: Option[];
  warehouses: Option[];
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const emailError = state.fieldErrors?.email;
  return (
    <div className="space-y-4">
      {/* Provides the action state so RoleScopeFields can show field errors. */}
      <FormStateContext value={state}>
        <form action={formAction} className="space-y-4" noValidate>
          {state.formError ? (
            <p
              role="alert"
              className="border-danger/40 bg-danger-surface text-danger rounded-md border px-3 py-2 text-sm"
            >
              {state.formError}
            </p>
          ) : null}
          <div>
            <label htmlFor="invite-email" className="mb-1 block text-sm font-medium">
              {labels.email}
            </label>
            <input
              id="invite-email"
              key={state.seq ?? 0}
              name="email"
              type="email"
              dir="ltr"
              required
              defaultValue={state.ok ? "" : (state.values?.email ?? "")}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? "invite-email-error" : undefined}
              className={inputClass}
            />
            {emailError ? (
              <p id="invite-email-error" className="text-danger mt-1 text-xs">
                {emailError}
              </p>
            ) : null}
          </div>
          <RoleScopeFields
            labels={labels}
            roles={roles}
            branches={branches}
            warehouses={warehouses}
          />
          <SubmitButton label={labels.submit} pendingLabel={labels.pending} />
        </form>
      </FormStateContext>
      {state.ok && state.data?.inviteUrl ? (
        <div className="border-success/40 bg-success-surface rounded-md border p-3">
          <CopyField
            value={state.data.inviteUrl}
            label={labels.link}
            copyLabel={labels.copy}
            copiedLabel={labels.copied}
          />
          <p className="text-muted mt-2 text-xs">
            {labels.linkHint.replace("{email}", state.data.email ?? "")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function GrantRoleForm({
  action,
  labels,
  roles,
  branches,
  warehouses,
}: {
  action: Action;
  labels: RoleScopeLabels & { submit: string; pending: string };
  roles: Option[];
  branches: Option[];
  warehouses: Option[];
}) {
  return (
    <ActionForm
      action={action}
      submitLabel={labels.submit}
      pendingLabel={labels.pending}
      submitVariant="secondary"
    >
      <RoleScopeFields labels={labels} roles={roles} branches={branches} warehouses={warehouses} />
    </ActionForm>
  );
}

export function RoleForm({
  action,
  labels,
  permissions,
  defaults,
  disabled = false,
}: {
  action: Action;
  labels: {
    submit: string;
    pending: string;
    name: string;
    description: string;
    permissions: string;
    optional: string;
  };
  permissions: Array<{ value: string; label: string; hint?: string }>;
  defaults?: { name: string; description: string; permissions: string[] };
  disabled?: boolean;
}) {
  return (
    <ActionForm
      action={action}
      submitLabel={labels.submit}
      pendingLabel={labels.pending}
      hideSubmit={disabled}
    >
      <TextField name="name" label={labels.name} defaultValue={defaults?.name} required />
      <TextField
        name="description"
        label={labels.description}
        defaultValue={defaults?.description}
        optionalLabel={labels.optional}
      />
      <CheckboxGroup
        name="permissions"
        legend={labels.permissions}
        options={permissions}
        defaultValues={defaults?.permissions}
        disabled={disabled}
      />
    </ActionForm>
  );
}
