"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import type { ActionState } from "@/components/forms/action-state";
import { initialActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/forms/fields";
import { inputClass } from "@/components/ui/styles";

export type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const PRODUCT_TYPES = [
  "RAW_MATERIAL",
  "SEMI_FINISHED",
  "FINISHED_GOOD",
  "PACKAGING",
  "CONSUMABLE",
] as const;
const LOT_MODES = ["NONE", "LOT", "LOT_AND_EXPIRY"] as const;
const ZONES = ["AMBIENT", "CHILLED", "FROZEN"] as const;
const DIMENSIONS = ["MASS", "VOLUME", "COUNT"] as const;
const SYMBOLOGIES = ["EAN13", "EAN8", "UPC_A", "CODE128", "QR", "INTERNAL"] as const;
const STATUSES = ["AVAILABLE", "QUARANTINE", "REJECTED", "ON_HOLD"] as const;
const ADJUSTMENT_REASONS = ["DATA_CORRECTION", "FOUND_STOCK", "UNIT_ERROR", "OTHER"] as const;
const WRITE_OFF_REASONS = [
  "EXPIRED",
  "DAMAGED",
  "SPOILED",
  "CONTAMINATED",
  "RECALLED",
  "OTHER",
] as const;
const STATUS_REASONS = [
  "QUALITY_CHECK",
  "TEMPERATURE_EXCURSION",
  "PACKAGING_DAMAGE",
  "SUPPLIER_ISSUE",
  "RECALL_INVESTIGATION",
  "RELEASED_AFTER_INSPECTION",
  "OTHER",
] as const;
const REVERSAL_REASONS = [
  "ENTERED_IN_ERROR",
  "WRONG_QUANTITY",
  "WRONG_ITEM_OR_LOT",
  "OTHER",
] as const;

function useOptions() {
  const t = useTranslations();
  return {
    t,
    reasons: (list: readonly string[]) =>
      list.map((r) => ({ value: r, label: t(`inventory.reasons.${r}`) })),
  };
}

// ─── Catalog ───

export function ProductForm({
  action,
  units,
  defaults = {},
  locked = false,
  submitLabel,
  idempotent = false,
}: {
  action: Action;
  units: Option[];
  defaults?: Record<string, string | undefined>;
  /** Base unit and lot tracking are frozen once the product has stock history. */
  locked?: boolean;
  submitLabel: string;
  idempotent?: boolean;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      idempotent={idempotent}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="sku"
          label={t("catalog.sku")}
          hint={t("catalog.skuHint")}
          defaultValue={defaults.sku}
          dir="ltr"
          required
        />
        <SelectField
          name="type"
          label={t("catalog.type")}
          options={PRODUCT_TYPES.map((v) => ({ value: v, label: t(`catalog.types.${v}`) }))}
          defaultValue={defaults.type ?? "RAW_MATERIAL"}
          required
        />
        <TextField
          name="nameEn"
          label={t("catalog.nameEn")}
          defaultValue={defaults.nameEn}
          dir="ltr"
          required
        />
        <TextField
          name="nameAr"
          label={t("catalog.nameAr")}
          defaultValue={defaults.nameAr}
          dir="rtl"
          optionalLabel={t("common.optional")}
        />
        {locked ? (
          <>
            <input type="hidden" name="baseUomId" value={defaults.baseUomId} />
            <input type="hidden" name="lotTracking" value={defaults.lotTracking} />
          </>
        ) : null}
        <SelectField
          name={locked ? "baseUomIdDisplay" : "baseUomId"}
          label={t("catalog.baseUnit")}
          hint={locked ? t("catalog.lockedAfterHistory") : t("catalog.baseUnitHint")}
          options={units}
          defaultValue={defaults.baseUomId}
          placeholder={t("common.select")}
          disabled={locked}
          errorKeys={["baseUomId"]}
          required
        />
        <SelectField
          name={locked ? "lotTrackingDisplay" : "lotTracking"}
          label={t("catalog.lotTracking")}
          hint={locked ? t("catalog.lockedAfterHistory") : undefined}
          options={LOT_MODES.map((v) => ({ value: v, label: t(`catalog.lotModes.${v}`) }))}
          defaultValue={defaults.lotTracking ?? "NONE"}
          disabled={locked}
          errorKeys={["lotTracking"]}
        />
        <TextField
          name="shelfLifeDays"
          label={t("catalog.shelfLifeDays")}
          defaultValue={defaults.shelfLifeDays}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="storageRequirement"
          label={t("catalog.storage")}
          options={ZONES.map((v) => ({ value: v, label: t(`catalog.zones.${v}`) }))}
          defaultValue={defaults.storageRequirement ?? "AMBIENT"}
        />
      </div>
    </ActionForm>
  );
}

export function UnitForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("catalog.newUnit")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-5">
        <TextField name="code" label={t("catalog.code")} dir="ltr" required />
        <TextField name="nameEn" label={t("catalog.nameEn")} dir="ltr" required />
        <TextField name="nameAr" label={t("catalog.nameAr")} dir="rtl" required />
        <SelectField
          name="dimension"
          label={t("catalog.dimension")}
          options={DIMENSIONS.map((v) => ({ value: v, label: t(`catalog.dimensions.${v}`) }))}
          defaultValue="COUNT"
        />
        <TextField
          name="factorToBase"
          label={t("catalog.size")}
          hint={t("catalog.packaging")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function BarcodeForm({ action, packUnits }: { action: Action; packUnits: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("catalog.addBarcode")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="barcode"
          label={t("catalog.barcode")}
          dir="ltr"
          inputMode="numeric"
          required
        />
        <SelectField
          name="symbology"
          label={t("catalog.symbology")}
          options={SYMBOLOGIES.map((v) => ({ value: v, label: t(`catalog.symbologies.${v}`) }))}
          defaultValue="EAN13"
        />
        <SelectField
          name="uomId"
          label={t("catalog.packUnit")}
          options={packUnits}
          placeholder={t("catalog.baseUnitOption")}
        />
      </div>
    </ActionForm>
  );
}

export function ConversionForm({
  action,
  units,
  baseUnit,
}: {
  action: Action;
  units: Option[];
  baseUnit: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("catalog.addConversion")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          name="uomId"
          label={t("catalog.conversionUnit")}
          options={units}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="factorToBase"
          label={`${t("catalog.factor")} (${baseUnit})`}
          inputMode="decimal"
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}

// ─── Inventory postings ───

interface StockFormOptions {
  places: Option[];
  products: Option[];
  units: Option[];
  currency: string;
}

function LotFields({ withBestBefore = false }: { withBestBefore?: boolean }) {
  const t = useTranslations();
  return (
    <>
      <TextField
        name="lotCode"
        label={t("inventory.lotCode")}
        hint={t("inventory.lotHint")}
        dir="ltr"
        optionalLabel={t("common.optional")}
      />
      <TextField
        name="expiresOn"
        type="date"
        label={t("inventory.expiresOn")}
        dir="ltr"
        optionalLabel={t("common.optional")}
      />
      {withBestBefore ? (
        <TextField
          name="bestBeforeOn"
          type="date"
          label={t("inventory.bestBeforeOn")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      ) : null}
    </>
  );
}

export function OpeningBalanceForm({
  action,
  options,
  defaults = {},
}: {
  action: Action;
  options: StockFormOptions;
  defaults?: Record<string, string>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.post")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="place"
          label={t("common.warehouse")}
          options={options.places}
          defaultValue={defaults.place}
          placeholder={t("common.select")}
          errorKeys={["warehouseId", "locationId"]}
          required
        />
        <SelectField
          name="productId"
          label={t("inventory.product")}
          options={options.products}
          defaultValue={defaults.productId}
          placeholder={t("common.select")}
          required
        />
        <LotFields withBestBefore />
        <TextField
          name="quantity"
          label={t("common.quantity")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="uomId"
          label={t("common.unit")}
          options={options.units}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="unitCost"
          label={t("inventory.unitCost")}
          hint={t("inventory.unitCostHint", { currency: options.currency })}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function AdjustmentForm({
  action,
  options,
  defaults = {},
}: {
  action: Action;
  options: StockFormOptions;
  defaults?: Record<string, string>;
}) {
  const { t, reasons } = useOptions();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.post")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="place"
          label={t("common.warehouse")}
          options={options.places}
          defaultValue={defaults.place}
          placeholder={t("common.select")}
          errorKeys={["warehouseId", "locationId"]}
          required
        />
        <SelectField
          name="productId"
          label={t("inventory.product")}
          options={options.products}
          defaultValue={defaults.productId}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="direction"
          label={t("inventory.direction")}
          options={[
            { value: "INCREASE", label: t("inventory.increase") },
            { value: "DECREASE", label: t("inventory.decrease") },
          ]}
          defaultValue={defaults.direction ?? "INCREASE"}
        />
        <SelectField
          name="stockStatus"
          label={t("inventory.status")}
          options={STATUSES.map((s) => ({ value: s, label: t(`inventory.statuses.${s}`) }))}
          defaultValue="AVAILABLE"
        />
        <LotFields />
        <TextField
          name="quantity"
          label={t("common.quantity")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="uomId"
          label={t("common.unit")}
          options={options.units}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="reasonCode"
          label={t("common.reason")}
          options={reasons(ADJUSTMENT_REASONS)}
          placeholder={t("common.select")}
          required
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

/** Hidden fields identifying the stock bucket an action applies to. */
function BucketFields({ bucket }: { bucket: Record<string, string> }) {
  return (
    <>
      {Object.entries(bucket).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

export function WriteOffForm({
  action,
  bucket,
  units,
}: {
  action: Action;
  bucket: Record<string, string>;
  units: Option[];
}) {
  const { t, reasons } = useOptions();
  return (
    <ActionForm
      action={action}
      submitLabel={t("inventory.writeOff")}
      pendingLabel={t("common.saving")}
      idempotent
      submitVariant="danger"
    >
      <BucketFields bucket={bucket} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="quantity"
          label={t("common.quantity")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="uomId"
          label={t("common.unit")}
          options={units}
          defaultValue={units[0]?.value}
          required
        />
        <SelectField
          name="reasonCode"
          label={t("common.reason")}
          options={reasons(WRITE_OFF_REASONS)}
          placeholder={t("common.select")}
          required
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function TransferForm({
  action,
  bucket,
  units,
  destinations,
}: {
  action: Action;
  bucket: Record<string, string>;
  units: Option[];
  destinations: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("inventory.transfer")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <BucketFields bucket={bucket} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="destination"
          label={t("inventory.destination")}
          options={destinations}
          placeholder={t("common.select")}
          errorKeys={["toWarehouseId", "toLocationId"]}
          required
        />
        <TextField
          name="quantity"
          label={t("common.quantity")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="uomId"
          label={t("common.unit")}
          options={units}
          defaultValue={units[0]?.value}
          required
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function StatusChangeForm({
  action,
  bucket,
  units,
  targets,
}: {
  action: Action;
  bucket: Record<string, string>;
  units: Option[];
  targets: string[];
}) {
  const { t, reasons } = useOptions();
  return (
    <ActionForm
      action={action}
      submitLabel={t("inventory.changeStatus")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <BucketFields bucket={bucket} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="toStatus"
          label={t("inventory.to")}
          options={targets.map((s) => ({ value: s, label: t(`inventory.statuses.${s}`) }))}
          defaultValue={targets[0]}
          required
        />
        <TextField
          name="quantity"
          label={t("common.quantity")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="uomId"
          label={t("common.unit")}
          options={units}
          defaultValue={units[0]?.value}
          required
        />
        <SelectField
          name="reasonCode"
          label={t("common.reason")}
          options={reasons(STATUS_REASONS)}
          placeholder={t("common.select")}
          required
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function ReverseForm({ action }: { action: Action }) {
  const { t, reasons } = useOptions();
  return (
    <ActionForm
      action={action}
      submitLabel={t("inventory.reverse")}
      pendingLabel={t("common.saving")}
      submitVariant="danger"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="reasonCode"
          label={t("common.reason")}
          options={reasons(REVERSAL_REASONS)}
          placeholder={t("common.select")}
          required
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

// ─── Counts ───

export function CreateCountForm({ action, places }: { action: Action; places: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("inventory.newCount")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="place"
          label={t("common.warehouse")}
          options={places}
          placeholder={t("common.select")}
          errorKeys={["warehouseId", "locationId"]}
          required
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export interface CountLineView {
  id: string;
  label: string;
  lot: string;
  location: string;
  unit: string;
  system: string;
  counted: string | null;
  /** counted − system, computed with exact decimals on the server. */
  difference: string | null;
}

/** Count sheet: one numeric input per line; saving records every filled-in line. */
export function CountSheetForm({
  action,
  lines,
  editable,
}: {
  action: Action;
  lines: CountLineView[];
  editable: boolean;
}) {
  const t = useTranslations();
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state.formError ? (
        <p
          role="alert"
          className="border-danger/40 bg-danger-surface text-danger rounded-md border px-3 py-2 text-sm"
        >
          {state.formError}
        </p>
      ) : null}
      {state.ok && state.message ? (
        <p
          role="status"
          className="border-success/40 bg-success-surface text-success rounded-md border px-3 py-2 text-sm"
        >
          {state.message}
        </p>
      ) : null}
      <div className="border-border bg-surface overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" aria-label={t("inventory.countsTitle")}>
          <thead>
            <tr>
              {[
                t("inventory.product"),
                t("inventory.lot"),
                t("common.location"),
                t("inventory.systemQty"),
                t("inventory.countedQty"),
                t("inventory.difference"),
              ].map((h) => (
                <th
                  key={h}
                  className="bg-surface-muted text-muted px-3 py-2 text-start text-xs font-semibold"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const name = `line:${l.id}`;
              const error = state.fieldErrors?.[name];
              const sign =
                l.difference === null
                  ? 0
                  : l.difference.startsWith("-")
                    ? -1
                    : l.difference === "0"
                      ? 0
                      : 1;
              return (
                <tr key={l.id} className="border-border border-t">
                  <td className="px-3 py-2">{l.label}</td>
                  <td className="px-3 py-2">
                    <span className="ltr-value font-mono text-xs">{l.lot}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="ltr-value font-mono text-xs">{l.location}</span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {l.counted !== null ? l.system : "—"} {l.counted !== null ? l.unit : ""}
                  </td>
                  <td className="px-3 py-2">
                    {editable ? (
                      <div>
                        <label htmlFor={name} className="sr-only">
                          {t("inventory.countedQty")} — {l.label} {l.lot}
                        </label>
                        <input
                          id={name}
                          key={`${state.seq ?? 0}-${l.counted}`}
                          name={name}
                          defaultValue={l.counted ?? ""}
                          inputMode="decimal"
                          dir="ltr"
                          aria-invalid={error ? true : undefined}
                          className={inputClass.replace("w-full", "w-32")}
                        />
                        {error ? <p className="text-danger mt-1 text-xs">{error}</p> : null}
                      </div>
                    ) : (
                      <span className="tabular-nums">{l.counted ?? "—"}</span>
                    )}
                  </td>
                  <td
                    className={`px-3 py-2 tabular-nums ${sign < 0 ? "text-danger" : sign > 0 ? "text-success" : ""}`}
                  >
                    <span className="ltr-value">
                      {l.difference === null ? "—" : `${sign > 0 ? "+" : ""}${l.difference}`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editable && lines.length > 0 ? (
        <SubmitButton
          label={t("inventory.saveCounts")}
          pendingLabel={t("common.saving")}
          variant="secondary"
        />
      ) : null}
    </form>
  );
}

export function AddCountLineForm({
  action,
  products,
  locations,
}: {
  action: Action;
  products: Option[];
  locations: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("inventory.addItem")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          name="productId"
          label={t("inventory.product")}
          options={products}
          placeholder={t("common.select")}
          required
        />
        {locations.length > 0 ? (
          <SelectField
            name="locationId"
            label={t("common.location")}
            options={locations}
            placeholder={t("common.noLocation")}
          />
        ) : null}
        <TextField
          name="lotCode"
          label={t("inventory.lotCode")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="expiresOn"
          type="date"
          label={t("inventory.expiresOn")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

// ─── Import ───

export function ImportForm({
  action,
  title,
  hint,
  templateHref,
}: {
  action: Action;
  title: string;
  hint: string;
  templateHref: string;
}) {
  const t = useTranslations();
  const [state, formAction] = useActionState(action, initialActionState);
  const errors: Array<{ row: number; column: string; message: string }> = state.data?.errors
    ? JSON.parse(state.data.errors)
    : [];
  return (
    <section className="border-border bg-surface space-y-3 rounded-lg border p-4 sm:p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-muted text-sm">{hint}</p>
      <a
        href={templateHref}
        className="text-primary inline-block text-sm font-medium hover:underline"
      >
        {t("import.template")}
      </a>
      <form action={formAction} className="space-y-3">
        <div>
          <label htmlFor={`${title}-file`} className="mb-1 block text-sm font-medium">
            {t("import.file")}
          </label>
          <input
            id={`${title}-file`}
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            className="block text-sm"
          />
        </div>
        <SubmitButton label={t("import.upload")} pendingLabel={t("common.saving")} />
      </form>
      {state.formError ? (
        <p
          role="alert"
          className="border-danger/40 bg-danger-surface text-danger rounded-md border px-3 py-2 text-sm"
        >
          {state.formError}
        </p>
      ) : null}
      {state.ok && state.message ? (
        <p
          role="status"
          className="border-success/40 bg-success-surface text-success rounded-md border px-3 py-2 text-sm"
        >
          {state.message}{" "}
          {state.data?.documents ? (
            <span className="ltr-value font-mono">{state.data.documents}</span>
          ) : null}
        </p>
      ) : null}
      {errors.length > 0 ? (
        <div className="border-border max-h-80 overflow-auto rounded-md border">
          <table className="w-full text-sm" aria-label={t("import.problem")}>
            <thead>
              <tr>
                {[t("import.row"), t("import.column"), t("import.problem")].map((h) => (
                  <th
                    key={h}
                    className="bg-surface-muted text-muted px-3 py-2 text-start text-xs font-semibold"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {errors.map((e, i) => (
                <tr key={i} className="border-border border-t">
                  <td className="px-3 py-1.5 tabular-nums">{e.row || "—"}</td>
                  <td className="px-3 py-1.5">
                    <span className="ltr-value font-mono text-xs">{e.column || "—"}</span>
                  </td>
                  <td className="px-3 py-1.5">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
