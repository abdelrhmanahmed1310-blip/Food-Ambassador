"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { initialActionState, type ActionState } from "@/components/forms/action-state";
import { SubmitButton } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function SalesImportForm({
  action,
  warehouses,
  templateHref,
  detailBase,
}: {
  action: Action;
  warehouses: Array<{ value: string; label: string }>;
  templateHref: string;
  detailBase: string;
}) {
  const t = useTranslations();
  const [state, formAction] = useActionState(action, initialActionState);
  const errors: Array<{ row: number; column: string; message: string }> = state.data?.errors
    ? JSON.parse(state.data.errors)
    : [];
  return (
    <section className="border-border bg-surface space-y-3 rounded-lg border p-4 sm:p-6">
      <h2 className="text-base font-semibold">{t("sales.uploadTitle")}</h2>
      <p className="text-muted text-sm">{t("sales.uploadHint")}</p>
      <a
        href={templateHref}
        className="text-primary inline-block text-sm font-medium hover:underline"
      >
        {t("import.template")}
      </a>
      <form action={formAction} className="space-y-3">
        <div>
          <label htmlFor="sales-warehouse" className="mb-1 block text-sm font-medium">
            {t("sales.warehouse")}
          </label>
          <select
            id="sales-warehouse"
            name="warehouseId"
            required
            defaultValue={warehouses.length === 1 ? warehouses[0].value : ""}
            className="border-border bg-surface rounded-md border px-3 py-2 text-sm"
          >
            <option value="">{t("common.select")}</option>
            {warehouses.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sales-file" className="mb-1 block text-sm font-medium">
            {t("import.file")}
          </label>
          <input
            id="sales-file"
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
          {state.data?.importId ? (
            <Link
              href={`${detailBase}/${state.data.importId}`}
              className="ltr-value font-mono underline"
            >
              {state.data.number}
            </Link>
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
