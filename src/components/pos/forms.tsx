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

/** A dining area of a branch; its kitchen uses stock from one warehouse of the branch. */
export function FloorForm({
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
    <ActionForm action={action} submitLabel={t("pos.addFloor")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="name" label={t("pos.floorName")} required />
        <div>
          <label htmlFor="floor-branch" className="mb-1 block text-sm font-medium">
            {t("pos.branch")}
          </label>
          <select
            id="floor-branch"
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
          label={t("pos.kitchenWarehouse")}
          hint={t("pos.kitchenWarehouseHint")}
          options={warehouses}
          required
        />
      </div>
    </ActionForm>
  );
}

export function TableForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("pos.addTable")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <TextField name="code" label={t("pos.tableCode")} dir="ltr" required />
        <TextField name="seats" label={t("pos.seats")} inputMode="numeric" dir="ltr" required />
        <TextField
          name="gridX"
          label={t("pos.column")}
          hint={t("pos.gridHint")}
          inputMode="numeric"
          dir="ltr"
          defaultValue="0"
          required
        />
        <TextField
          name="gridY"
          label={t("pos.row")}
          inputMode="numeric"
          dir="ltr"
          defaultValue="0"
          required
        />
      </div>
    </ActionForm>
  );
}

/** Open a check at a table (tableId) or a named one without a table (branchId + label). */
export function OpenTabForm({
  action,
  tableId,
  branchId,
  seats,
}: {
  action: Action;
  tableId?: string;
  branchId?: string;
  seats?: number;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("pos.openCheck")} pendingLabel={t("common.saving")}>
      {tableId ? <input type="hidden" name="tableId" value={tableId} /> : null}
      {branchId ? <input type="hidden" name="branchId" value={branchId} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {tableId ? null : <TextField name="label" label={t("pos.checkName")} required />}
        <TextField
          name="guests"
          label={t("pos.guests")}
          inputMode="numeric"
          dir="ltr"
          defaultValue={seats ? String(Math.min(seats, 2)) : "1"}
          required
        />
      </div>
    </ActionForm>
  );
}

export function StationForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("pos.addStation")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-4">
        <SelectField name="branchId" label={t("pos.branch")} options={branches} required />
        <TextField name="code" label={t("pos.code")} dir="ltr" required />
        <TextField name="name" label={t("pos.name")} required />
        <TextField
          name="targetMinutes"
          label={t("pos.targetMinutes")}
          hint={t("pos.targetMinutesHint")}
          inputMode="numeric"
          dir="ltr"
          defaultValue="12"
          required
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isDefault" />
        {t("pos.defaultStation")}
      </label>
    </ActionForm>
  );
}

/** Route a menu category, or one item, to a station. */
export function RouteForm({
  action,
  categories,
  items,
}: {
  action: Action;
  categories: Option[];
  items: Option[];
}) {
  const t = useTranslations();
  const [by, setBy] = useState<"category" | "item">("category");
  return (
    <ActionForm
      action={action}
      submitLabel={t("pos.addRoute")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="route-by" className="mb-1 block text-sm font-medium">
            {t("pos.routeBy")}
          </label>
          <select
            id="route-by"
            className={inputClass}
            value={by}
            onChange={(e) => setBy(e.target.value as "category" | "item")}
          >
            <option value="category">{t("pos.routeByCategory")}</option>
            <option value="item">{t("pos.routeByItem")}</option>
          </select>
        </div>
        {by === "category" ? (
          <SelectField name="categoryId" label={t("menu.category")} options={categories} required />
        ) : (
          <SelectField name="menuItemId" label={t("pos.item")} options={items} required />
        )}
      </div>
    </ActionForm>
  );
}
