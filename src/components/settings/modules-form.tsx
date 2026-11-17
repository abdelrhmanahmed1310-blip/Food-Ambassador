"use client";

import { useState } from "react";
import { ActionForm } from "@/components/forms/fields";
import type { ActionState } from "@/components/forms/action-state";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export interface ModuleRow {
  key: string;
  label: string;
  switchable: boolean;
  on: boolean;
  needs: string | null;
  features: Array<{ key: string; label: string; core: boolean; on: boolean; needs: string | null }>;
}

/**
 * Settings → Modules (ADR-137): a switch per module and per function. A
 * function keeps its own switch while its module is off, so switching the
 * module back on restores it as it was.
 */
export function ModulesForm({
  action,
  modules,
  labels,
}: {
  action: Action;
  modules: ModuleRow[];
  labels: { submit: string; pending: string; core: string; moduleOff: string };
}) {
  const [moduleOn, setModuleOn] = useState(() =>
    Object.fromEntries(modules.map((m) => [m.key, m.on])),
  );
  return (
    <ActionForm action={action} submitLabel={labels.submit} pendingLabel={labels.pending}>
      <div className="grid gap-4 lg:grid-cols-2">
        {modules.map((m) => {
          const off = m.switchable && !moduleOn[m.key];
          return (
            <fieldset
              key={m.key}
              className="border-border bg-surface rounded-lg border p-4"
              data-testid={`module-${m.key}`}
            >
              <legend className="px-1 font-semibold">
                {m.switchable ? (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name={`module:${m.key}`}
                      checked={moduleOn[m.key]}
                      onChange={(e) => setModuleOn((s) => ({ ...s, [m.key]: e.target.checked }))}
                      className="size-4"
                    />
                    {m.label}
                  </label>
                ) : (
                  m.label
                )}
              </legend>
              {m.needs ? <p className="text-muted mb-2 text-xs">{m.needs}</p> : null}
              {off ? <p className="text-warning mb-2 text-xs">{labels.moduleOff}</p> : null}
              <ul className={`space-y-1.5 ${off ? "opacity-50" : ""}`}>
                {m.features.map((f) => (
                  <li key={f.key}>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        name={`feature:${f.key}`}
                        defaultChecked={f.on}
                        disabled={f.core}
                        className="mt-0.5 size-4"
                      />
                      <span>
                        {f.label}
                        {f.core ? (
                          <span className="text-muted ms-1 text-xs">({labels.core})</span>
                        ) : null}
                        {f.needs ? (
                          <span className="text-muted block text-xs">{f.needs}</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          );
        })}
      </div>
    </ActionForm>
  );
}
