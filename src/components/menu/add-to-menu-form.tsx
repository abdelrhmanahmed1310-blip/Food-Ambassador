"use client";

import { useRef } from "react";
import { ActionForm } from "@/components/forms/fields";
import type { ActionState } from "@/components/forms/action-state";
import { inputClass } from "@/components/ui/styles";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export interface AddRow {
  key: string;
  code: string;
  name: string;
  type: string;
  detail: string;
  onMenu: boolean;
}

/**
 * Menu → Add products and dishes (ADR-138): tick rows, give each a price, and
 * add them all to one category on the chosen channels.
 */
export function AddToMenuForm({
  action,
  rows,
  categories,
  channels,
  branches,
  labels,
}: {
  action: Action;
  rows: AddRow[];
  categories: Array<{ value: string; label: string }>;
  channels: Array<{ value: string; label: string }>;
  branches: Array<{ value: string; label: string }>;
  labels: Record<
    | "submit"
    | "pending"
    | "category"
    | "channels"
    | "branch"
    | "allBranches"
    | "selectAll"
    | "price"
    | "onMenu"
    | "item"
    | "type"
    | "choose",
    string
  >;
}) {
  const table = useRef<HTMLTableSectionElement>(null);
  const toggleAll = (on: boolean) =>
    table.current
      ?.querySelectorAll<HTMLInputElement>('input[name="pick"]:not(:disabled)')
      .forEach((c) => {
        c.checked = on;
      });
  return (
    <ActionForm action={action} submitLabel={labels.submit} pendingLabel={labels.pending}>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm" htmlFor="add-category">
          <span className="mb-1 block font-medium">{labels.category}</span>
          <select
            id="add-category"
            name="categoryId"
            required
            className={inputClass}
            defaultValue=""
          >
            <option value="" disabled>
              {labels.choose}
            </option>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="text-sm">
          <legend className="mb-1 font-medium">{labels.channels}</legend>
          <div className="flex flex-wrap gap-3">
            {channels.map((c) => (
              <label key={c.value} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="channel"
                  value={c.value}
                  defaultChecked
                  className="size-4"
                />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-sm" htmlFor="add-branch">
          <span className="mb-1 block font-medium">{labels.branch}</span>
          <select id="add-branch" name="branchId" className={inputClass} defaultValue="">
            <option value="">{labels.allBranches}</option>
            {branches.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-surface-muted text-muted text-xs">
            <tr>
              <th className="px-3 py-2 text-start">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={labels.selectAll}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="size-4"
                  />
                  {labels.item}
                </label>
              </th>
              <th className="px-3 py-2 text-start">{labels.type}</th>
              <th className="px-3 py-2 text-start">{labels.price}</th>
            </tr>
          </thead>
          <tbody ref={table} className="divide-border divide-y">
            {rows.map((r) => (
              <tr key={r.key} data-testid="add-row">
                <td className="px-3 py-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      name="pick"
                      value={r.key}
                      disabled={r.onMenu}
                      aria-label={r.name}
                      className="mt-0.5 size-4"
                    />
                    <span className="min-w-0">
                      <span className="ltr-value font-mono text-xs">{r.code}</span> —{" "}
                      <bdi className="font-medium">{r.name}</bdi>
                      {r.detail ? (
                        <span className="text-muted block text-xs">{r.detail}</span>
                      ) : null}
                    </span>
                  </label>
                </td>
                <td className="px-3 py-2">
                  {r.type}
                  {r.onMenu ? (
                    <span className="text-muted block text-xs">{labels.onMenu}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <input
                    name={`price:${r.key}`}
                    inputMode="decimal"
                    dir="ltr"
                    disabled={r.onMenu}
                    aria-label={`${labels.price}: ${r.name}`}
                    className={`${inputClass} w-28`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ActionForm>
  );
}
