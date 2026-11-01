"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import { inputClass } from "@/components/ui/styles";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

/** A register belongs to a branch and uses one of its warehouses for stock. */
export function RegisterForm({
  action,
  branches,
}: {
  action: Action;
  branches: Array<{ id: string; label: string; warehouses: Option[] }>;
}) {
  const t = useTranslations();
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const warehouses = branches.find((b) => b.id === branchId)?.warehouses ?? [];
  return (
    <ActionForm
      action={action}
      submitLabel={t("pos.addRegister")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("pos.code")} dir="ltr" required />
        <TextField name="name" label={t("pos.name")} required />
        <div>
          <label htmlFor="register-branch" className="mb-1 block text-sm font-medium">
            {t("pos.branch")}
          </label>
          <select
            id="register-branch"
            name="branchId"
            className={inputClass}
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        <SelectField
          key={branchId}
          name="warehouseId"
          label={t("pos.stockWarehouse")}
          hint={t("pos.stockWarehouseHint")}
          options={warehouses}
          required
        />
      </div>
    </ActionForm>
  );
}

export function OpenShiftForm({ action, currency }: { action: Action; currency: string }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("pos.openShift")} pendingLabel={t("common.saving")}>
      <TextField
        name="openingFloat"
        label={t("pos.openingFloat", { currency })}
        hint={t("pos.openingFloatHint")}
        inputMode="decimal"
        dir="ltr"
        defaultValue="0"
        required
      />
    </ActionForm>
  );
}

export function CashMovementForm({ action, currency }: { action: Action; currency: string }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("pos.recordMovement")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="kind"
          label={t("pos.movementKind")}
          options={[
            { value: "PAY_OUT", label: t("pos.movementKinds.PAY_OUT") },
            { value: "PAY_IN", label: t("pos.movementKinds.PAY_IN") },
          ]}
          required
        />
        <TextField
          name="amount"
          label={t("pos.amountIn", { currency })}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField name="reason" label={t("pos.reason")} required />
      </div>
    </ActionForm>
  );
}

export function CloseShiftForm({ action, currency }: { action: Action; currency: string }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("pos.closeShift")}
      pendingLabel={t("common.saving")}
      submitVariant="danger"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="countedCash"
          label={t("pos.countedCash", { currency })}
          hint={t("pos.countedCashHint")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField name="note" label={t("pos.closeNote")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

/** Choose quantities per line; the amount follows each line's price and VAT. */
export function RefundForm({
  action,
  lines,
  registers,
}: {
  action: Action;
  lines: Array<{ id: string; label: string; remaining: string }>;
  registers: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("pos.refund")}
      pendingLabel={t("common.saving")}
      submitVariant="danger"
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {lines.map((l) => (
          <TextField
            key={l.id}
            name={`qty_${l.id}`}
            label={l.label}
            hint={t("pos.refundLeft", { quantity: l.remaining })}
            inputMode="decimal"
            dir="ltr"
            optionalLabel={t("common.optional")}
          />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="registerId"
          label={t("pos.refundRegister")}
          options={registers}
          required
        />
        <SelectField
          name="method"
          label={t("pos.refundMethod")}
          options={[
            { value: "CASH", label: t("pos.methods.CASH") },
            { value: "CARD", label: t("pos.methods.CARD") },
          ]}
          required
        />
        <TextField name="reason" label={t("pos.reason")} required />
      </div>
    </ActionForm>
  );
}
