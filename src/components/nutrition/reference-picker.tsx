"use client";

import { useFormStatus } from "react-dom";
import { ActionForm } from "@/components/forms/fields";
import type { ActionState } from "@/components/forms/action-state";
import { buttonClass } from "@/components/ui/styles";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export interface PickerItem {
  /** "food:<id>" for a library food, "fdc:<id>" for a USDA record not in the library yet. */
  pick: string;
  name: string;
  meta: string;
}

function UseButton({ pick, label, name }: { pick: string; label: string; name: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="pick"
      value={pick}
      disabled={pending}
      aria-label={`${label}: ${name}`}
      className={buttonClass("secondary")}
    >
      {label}
    </button>
  );
}

/**
 * Choose a product's library food (ADR-136): suggestions and search results,
 * each with a "Use" button, in one form so the outcome stays on screen.
 */
export function ReferencePicker({
  action,
  groups,
  useLabel,
}: {
  action: Action;
  groups: Array<{ title: string; empty?: string; items: PickerItem[] }>;
  useLabel: string;
}) {
  return (
    <ActionForm action={action} submitLabel={useLabel} hideSubmit className="space-y-4">
      {groups.map((g) => (
        <section key={g.title} className="space-y-2">
          <h3 className="text-sm font-medium">{g.title}</h3>
          {g.items.length === 0 ? (
            g.empty ? (
              <p className="text-muted text-sm">{g.empty}</p>
            ) : null
          ) : (
            <ul className="divide-border border-border divide-y rounded-md border">
              {g.items.map((i) => (
                <li
                  key={i.pick}
                  className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm"
                  data-testid="reference-option"
                >
                  <span className="min-w-0">
                    <bdi className="font-medium">{i.name}</bdi>
                    <span className="text-muted block text-xs">{i.meta}</span>
                  </span>
                  <UseButton pick={i.pick} label={useLabel} name={i.name} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </ActionForm>
  );
}
