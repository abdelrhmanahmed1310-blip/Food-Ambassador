"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Start a timed drill on one lot (ADR-100). */
export function StartMockRecallForm({
  action,
  branches,
  lotId,
}: {
  action: Action;
  branches: Option[];
  lotId: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("mockRecalls.start")}
      pendingLabel={t("common.saving")}
    >
      <input type="hidden" name="lotId" value={lotId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="branchId"
          label={t("mockRecalls.branch")}
          hint={t("mockRecalls.branchHint")}
          options={branches}
          placeholder={t("common.select")}
          defaultValue={branches.length === 1 ? branches[0].value : undefined}
          required
        />
        <TextField
          name="targetMinutes"
          label={t("mockRecalls.target")}
          hint={t("mockRecalls.targetHint")}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <div className="sm:col-span-2">
          <TextField
            name="scenario"
            label={t("mockRecalls.scenario")}
            hint={t("mockRecalls.scenarioHint")}
            required
          />
        </div>
      </div>
    </ActionForm>
  );
}

/** One "found" field per place the book showed stock, then stop the clock. */
export function CompleteMockRecallForm({
  action,
  counts,
}: {
  action: Action;
  counts: Array<{ id: string; label: string; book: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("mockRecalls.complete")}
      pendingLabel={t("common.saving")}
    >
      {counts.length === 0 ? (
        <p className="text-muted text-sm">{t("mockRecalls.noStockHint")}</p>
      ) : (
        counts.map((c, i) => (
          <fieldset key={c.id} className="border-border rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">
              {c.label} · {t("mockRecalls.book")} <span className="ltr-value">{c.book}</span>
            </legend>
            <input type="hidden" name={`counts.${i}.id`} value={c.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                name={`counts.${i}.foundQuantity`}
                label={`${t("mockRecalls.found")} — ${c.label}`}
                inputMode="decimal"
                dir="ltr"
                required
              />
              <TextField
                name={`counts.${i}.note`}
                label={t("common.note")}
                optionalLabel={t("common.optional")}
              />
            </div>
          </fieldset>
        ))
      )}
      <TextField
        name="findings"
        label={t("mockRecalls.findings")}
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}

export function CancelMockRecallForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("mockRecalls.cancel")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <TextField name="note" label={t("mockRecalls.cancelReason")} required />
    </ActionForm>
  );
}

/** A running clock from the start time, ticking every second. */
export function ElapsedClock({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  if (now === null) return <span className="ltr-value tabular-nums">—</span>;
  const s = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="ltr-value font-mono tabular-nums" aria-live="off">
      {pad(Math.floor(s / 3600))}:{pad(Math.floor((s % 3600) / 60))}:{pad(s % 60)}
    </span>
  );
}
