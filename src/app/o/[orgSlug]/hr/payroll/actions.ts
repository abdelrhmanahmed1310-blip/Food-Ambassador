"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addContributionRule,
  addPayrollAdjustment,
  approvePayrollRun,
  cancelPayrollRun,
  createPayrollRun,
  endContributionRule,
  markPayrollRunPaid,
  addOvertimeToRun,
  recalculatePayrollRun,
  removePayrollAdjustment,
  setBankAccount,
  setProrationBasis,
  setSalary,
  addEosRule,
  addTaxTable,
  endPayrollRule,
  settleEndOfService,
} from "@/modules/payroll/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

const saved = async () => ({ message: (await getTranslations("common"))("savedSuccessfully") });

export async function setProrationAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setProrationBasis(ctx, formValues(formData));
    return saved();
  });
}

export async function createRunAction(orgSlug: string, previous: S, formData: FormData) {
  let id: string | undefined;
  const result = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createPayrollRun(ctx, formValues(formData))).id;
  });
  if (id) redirect(`/o/${orgSlug}/hr/payroll/${id}`);
  return result;
}

export async function addOvertimeAction(
  orgSlug: string,
  runId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("payroll");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const { added } = await addOvertimeToRun(ctx, runId);
    return { message: t("overtimeAdded", { count: added }) };
  });
}
export async function recalculateAction(
  orgSlug: string,
  runId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => recalculatePayrollRun(ctx, runId));
}

export async function addAdjustmentAction(
  orgSlug: string,
  runId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addPayrollAdjustment(ctx, runId, formValues(formData));
    return saved();
  });
}

export async function removeAdjustmentAction(
  orgSlug: string,
  id: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => removePayrollAdjustment(ctx, id));
}

export async function approveRunAction(
  orgSlug: string,
  runId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) => approvePayrollRun(ctx, runId));
}

export async function markPaidAction(
  orgSlug: string,
  runId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    markPayrollRunPaid(ctx, runId, formValues(formData)),
  );
}

export async function cancelRunAction(
  orgSlug: string,
  runId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    cancelPayrollRun(ctx, runId, formValues(formData)),
  );
}

export async function addRuleAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addContributionRule(ctx, formValues(formData));
    return saved();
  });
}

export async function endRuleAction(
  orgSlug: string,
  ruleId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    endContributionRule(ctx, ruleId, formValues(formData)),
  );
}

/** `items.<i>.<field>` form fields as rows. */
function rows(values: Record<string, string>) {
  const out: Array<Record<string, string>> = [];
  for (const [key, value] of Object.entries(values)) {
    const m = /^items\.(\d+)\.(\w+)$/.exec(key);
    if (!m) continue;
    (out[Number(m[1])] ??= {})[m[2]] = value;
  }
  return out.filter(Boolean);
}

export async function setSalaryAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const v = formValues(formData);
    await setSalary(ctx, employeeId, { ...v, items: rows(v) });
    return saved();
  });
}

export async function setBankAction(
  orgSlug: string,
  employeeId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setBankAccount(ctx, employeeId, formValues(formData));
    return saved();
  });
}

/** `a.0.b.1.c` form fields as nested objects and arrays. */
function nested(values: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const parts = key.split(".");
    let node: Record<string, unknown> | unknown[] = root;
    parts.forEach((part, k) => {
      const last = k === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[k + 1]);
      const slot = /^\d+$/.test(part) ? Number(part) : part;
      const container = node as Record<string | number, unknown>;
      if (last) container[slot] = value;
      else {
        container[slot] ??= nextIsIndex ? [] : {};
        node = container[slot] as Record<string, unknown> | unknown[];
      }
    });
  }
  // Holes from unsent rows become empty objects, which the service skips.
  const fill = (v: unknown): unknown =>
    Array.isArray(v)
      ? Array.from(v, (x) => fill(x ?? {}))
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
        : v;
  return fill(root) as Record<string, unknown>;
}

export async function addTaxTableAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addTaxTable(ctx, nested(formValues(formData)));
    return saved();
  });
}

export async function addEosRuleAction(orgSlug: string, previous: S, formData: FormData) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await addEosRule(ctx, nested(formValues(formData)));
    return saved();
  });
}

export async function endTaxOrEosAction(
  orgSlug: string,
  kind: "tax" | "eos",
  ruleId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    endPayrollRule(ctx, kind, ruleId, formValues(formData)),
  );
}

export async function settleAction(
  orgSlug: string,
  runId: string,
  previous: S,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await settleEndOfService(ctx, runId, formValues(formData));
    return saved();
  });
}
