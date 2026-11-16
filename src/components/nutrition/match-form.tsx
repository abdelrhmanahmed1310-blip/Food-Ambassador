"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { ActionForm } from "@/components/forms/fields";
import type { ActionState } from "@/components/forms/action-state";
import { buttonClass, inputClass } from "@/components/ui/styles";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export interface MatchRow {
  productId: string;
  sku: string;
  name: string;
  type: string;
  candidates: Array<{ id: string; label: string }>;
}

/**
 * Products without a library food and the suggested foods (ADR-136). Nothing
 * is chosen for anyone: a person picks per row, or takes every first
 * suggestion with one button and reviews before confirming.
 */
export function MatchForm({
  action,
  rows,
  empty,
}: {
  action: Action;
  rows: MatchRow[];
  /** Shown when every product is linked; the form stays mounted so its outcome stays visible. */
  empty: string;
}) {
  const t = useTranslations("productReference");
  const form = useRef<HTMLDivElement>(null);
  const takeBest = () =>
    form.current?.querySelectorAll<HTMLSelectElement>("select[data-best]").forEach((s) => {
      s.value = s.dataset.best ?? "";
    });
  return (
    <ActionForm
      action={action}
      submitLabel={t("confirmLinks")}
      className="space-y-3"
      hideSubmit={rows.length === 0}
    >
      {rows.length === 0 ? (
        <p className="text-muted text-sm">{empty}</p>
      ) : (
        <button type="button" className={buttonClass("secondary")} onClick={takeBest}>
          {t("takeBest")}
        </button>
      )}
      <div
        ref={form}
        hidden={rows.length === 0}
        className="border-border divide-border divide-y rounded-md border"
      >
        {rows.map((r) => (
          <div
            key={r.productId}
            className="grid gap-2 p-3 text-sm md:grid-cols-[1fr_24rem]"
            data-testid="match-row"
          >
            <label htmlFor={`pick-${r.productId}`} className="min-w-0">
              <span className="ltr-value font-mono">{r.sku}</span> — <bdi>{r.name}</bdi>
              <span className="text-muted block text-xs">{r.type}</span>
            </label>
            {r.candidates.length === 0 ? (
              <span className="text-muted text-xs">{t("noSuggestion")}</span>
            ) : (
              <select
                id={`pick-${r.productId}`}
                name={`pick:${r.productId}`}
                defaultValue=""
                data-best={r.candidates[0].id}
                className={inputClass}
              >
                <option value="">{t("dontLink")}</option>
                {r.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>
    </ActionForm>
  );
}
