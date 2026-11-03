"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField, useFormState } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** A new request for quotation (ADR-092). */
export function RfqForm({ action, warehouses }: { action: Action; warehouses: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.create")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField name="title" label={t("rfqs.titleField")} required />
        </div>
        <SelectField
          name="warehouseId"
          label={t("rfqs.deliverTo")}
          options={warehouses}
          placeholder={t("common.select")}
          defaultValue={warehouses.length === 1 ? warehouses[0].value : undefined}
          required
        />
        <TextField
          name="respondBy"
          type="date"
          label={t("rfqs.respondBy")}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="neededBy"
          type="date"
          label={t("rfqs.neededBy")}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="note"
          label={t("rfqs.noteForSuppliers")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function InviteSupplierForm({ action, suppliers }: { action: Action; suppliers: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("rfqs.askSupplier")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-3"
    >
      <div className="min-w-64">
        <SelectField
          name="supplierId"
          label={t("purchasing.supplier")}
          options={suppliers}
          placeholder={t("common.select")}
          required
        />
      </div>
    </ActionForm>
  );
}

export interface QuotableLine {
  id: string;
  label: string;
  quantity: string;
  unit: string;
}

/** Record a supplier's quotation as received: one price per line, per the line's unit. */
export function QuotationForm({
  action,
  suppliers,
  currencies,
  lines,
  defaults,
  submitLabel,
}: {
  action: Action;
  suppliers: Option[];
  currencies: Option[];
  lines: QuotableLine[];
  defaults?: {
    supplierId: string;
    currency: string;
    reference?: string;
    quotedOn: string;
    validUntil?: string;
    leadTimeDays?: string;
    note?: string;
    prices: Record<string, { unitPrice: string; quantity?: string }>;
  };
  submitLabel: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={submitLabel} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-3">
        {defaults ? (
          <input type="hidden" name="supplierId" value={defaults.supplierId} />
        ) : (
          <SelectField
            name="supplierId"
            label={t("purchasing.supplier")}
            options={suppliers}
            placeholder={t("common.select")}
            required
          />
        )}
        <SelectField
          name="currency"
          label={t("fx.currency")}
          options={currencies}
          defaultValue={defaults?.currency}
          placeholder={t("rfqs.supplierCurrency")}
        />
        <TextField
          name="reference"
          label={t("rfqs.reference")}
          defaultValue={defaults?.reference}
          optionalLabel={t("common.optional")}
          dir="ltr"
        />
        <TextField
          name="quotedOn"
          type="date"
          label={t("rfqs.quotedOn")}
          defaultValue={defaults?.quotedOn}
          required
        />
        <TextField
          name="validUntil"
          type="date"
          label={t("rfqs.validUntil")}
          defaultValue={defaults?.validUntil}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="leadTimeDays"
          label={t("rfqs.leadTimeDays")}
          defaultValue={defaults?.leadTimeDays}
          optionalLabel={t("common.optional")}
          inputMode="numeric"
          dir="ltr"
        />
      </div>
      {lines.map((l, i) => (
        <fieldset key={l.id} className="border-border rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">
            {l.label} —{" "}
            <span className="ltr-value tabular-nums">
              {l.quantity} {l.unit}
            </span>
          </legend>
          <input type="hidden" name={`lines.${i}.rfqLineId`} value={l.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name={`lines.${i}.unitPrice`}
              label={t("rfqs.unitPricePer", { unit: l.unit })}
              hint={t("rfqs.blankNotQuoted")}
              defaultValue={defaults?.prices[l.id]?.unitPrice}
              inputMode="decimal"
              dir="ltr"
            />
            <TextField
              name={`lines.${i}.quantity`}
              label={t("rfqs.offeredQuantity", { unit: l.unit })}
              hint={t("rfqs.blankFullQuantity")}
              defaultValue={defaults?.prices[l.id]?.quantity}
              inputMode="decimal"
              dir="ltr"
            />
          </div>
        </fieldset>
      ))}
      <TextField
        name="note"
        label={t("common.note")}
        defaultValue={defaults?.note}
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}

export interface AwardOffer {
  quotationLineId: string;
  label: string;
  detail: string;
  lowest: boolean;
  expired: boolean;
  needsReason: boolean;
}

export interface AwardLine {
  id: string;
  label: string;
  offers: AwardOffer[];
}

function OfferChoice({ line, index }: { line: AwardLine; index: number }) {
  const t = useTranslations();
  const state = useFormState();
  const name = `lines.${index}.quotationLineId`;
  const chosen =
    state.values?.[name] ?? line.offers.find((o) => o.lowest && !o.expired)?.quotationLineId ?? "";
  const error = state.fieldErrors?.[name];
  return (
    <div role="radiogroup" aria-label={line.label} className="space-y-1">
      {line.offers.map((o) => (
        <label key={o.quotationLineId} className="flex items-start gap-2 text-sm">
          <input
            key={`${state.seq ?? 0}-${chosen}`}
            type="radio"
            name={name}
            value={o.quotationLineId}
            defaultChecked={chosen === o.quotationLineId}
            disabled={o.expired}
            className="mt-1"
          />
          <span>
            {o.label} <span className="ltr-value tabular-nums">{o.detail}</span>
            {o.lowest ? (
              <span className="text-success ms-2 text-xs">{t("rfqs.lowest")}</span>
            ) : null}
            {o.expired ? (
              <span className="text-muted ms-2 text-xs">{t("rfqs.expired")}</span>
            ) : null}
            {o.needsReason && !o.expired ? (
              <span className="text-muted block text-xs">{t("rfqs.reasonNeeded")}</span>
            ) : null}
          </span>
        </label>
      ))}
      <label className="flex items-center gap-2 text-sm">
        <input
          key={`${state.seq ?? 0}-${chosen}-none`}
          type="radio"
          name={name}
          value=""
          defaultChecked={chosen === ""}
        />
        {t("rfqs.notAwarded")}
      </label>
      {error ? (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Choose an offer per line; one draft order per chosen supplier. */
export function AwardForm({ action, lines }: { action: Action; lines: AwardLine[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("rfqs.award")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      {lines.map((l, i) => (
        <fieldset key={l.id} className="border-border rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{l.label}</legend>
          <input type="hidden" name={`lines.${i}.rfqLineId`} value={l.id} />
          {l.offers.length === 0 ? (
            <p className="text-muted text-sm">{t("rfqs.noOffers")}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <OfferChoice line={l} index={i} />
              <TextField
                name={`lines.${i}.reason`}
                label={t("rfqs.awardReason")}
                hint={t("rfqs.awardReasonHint")}
                optionalLabel={t("common.optional")}
              />
            </div>
          )}
        </fieldset>
      ))}
      <TextField
        name="expectedOn"
        type="date"
        label={t("purchasing.expectedOn")}
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}
