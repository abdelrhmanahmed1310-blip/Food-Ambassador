"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  archivePlan,
  assignPlan,
  generateStatements,
  issueStatement,
  requireOperator,
  savePlan,
} from "@/modules/billing/platform";
import { USAGE_METRICS } from "@/modules/usage/rules";
import { formValues, runFormAction } from "@/server/actions/handle";

type S = ActionState;
const field = (m: string) => m.replace(".", "_");

/** A plan from the form: fee and, per metric, included quantity, price and unit (ADR-147). */
export async function savePlanAction(previous: S, formData: FormData) {
  const t = await getTranslations("platform");
  return runFormAction(previous, formData, async () => {
    const v = formValues(formData);
    const pricing = Object.fromEntries(
      USAGE_METRICS.flatMap((m) => {
        const included = v[`included_${field(m)}`] ?? "";
        const unitPrice = v[`price_${field(m)}`] ?? "";
        if (!included && !unitPrice) return [];
        return [
          [
            m,
            {
              included: included || "0",
              unitPrice: unitPrice || "0",
              per: v[`per_${field(m)}`] || "1",
            },
          ],
        ];
      }),
    );
    await savePlan(await requireOperator(), {
      code: v.code,
      name: v.name,
      currency: v.currency,
      monthlyFee: v.monthlyFee,
      pricing,
    });
    revalidatePath("/platform");
    return { message: t("planSaved") };
  });
}

export async function archivePlanAction(planId: string, previous: S, formData: FormData) {
  return runFormAction(previous, formData, async () => {
    await archivePlan(await requireOperator(), planId);
    revalidatePath("/platform");
  });
}

export async function assignPlanAction(organizationId: string, previous: S, formData: FormData) {
  const t = await getTranslations("platform");
  return runFormAction(previous, formData, async () => {
    const planId = String(formData.get("planId") ?? "");
    await assignPlan(await requireOperator(), organizationId, planId || null);
    revalidatePath("/platform");
    return { message: t("assigned") };
  });
}

export async function generateStatementsAction(month: string, previous: S, formData: FormData) {
  const t = await getTranslations("platform");
  return runFormAction(previous, formData, async () => {
    const r = await generateStatements(await requireOperator(), month);
    revalidatePath("/platform");
    return { message: t("generated", { count: r.made }) };
  });
}

export async function issueStatementAction(statementId: string, previous: S, formData: FormData) {
  return runFormAction(previous, formData, async () => {
    await issueStatement(await requireOperator(), statementId);
    revalidatePath("/platform");
  });
}
