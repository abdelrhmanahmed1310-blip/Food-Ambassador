import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ExpenseForm } from "@/components/finance/expense-forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { expenseFormOptions } from "@/modules/finance/expenses";
import { businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { recordExpenseAction } from "../actions";

export default async function NewExpensePage({
  params,
}: PageProps<"/o/[orgSlug]/finance/expenses/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "expenses.manage")) notFound();
  const [t, locale, o] = await Promise.all([
    getTranslations(),
    getLocale(),
    expenseFormOptions(ctx),
  ]);
  const name = (x: { name: string; nameAr?: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  return (
    <>
      <PageHeader title={t("expenses.newTitle")} description={t("expenses.newHint")} />
      {o.categories.length === 0 ? (
        <EmptyState
          title={t("expenses.noCategories")}
          action={
            <Link
              href={`/o/${orgSlug}/finance/expenses/setup`}
              className="text-primary hover:underline"
            >
              {t("expenses.setup")}
            </Link>
          }
        />
      ) : (
        <Card>
          <ExpenseForm
            action={recordExpenseAction.bind(null, orgSlug)}
            today={businessDate(ctx.timeZone)}
            branches={o.branches.map((b) => ({
              value: b.id,
              label: `${b.code} — ${b.name} (${b.company.currency})`,
            }))}
            categories={o.categories.map((c) => ({
              value: c.id,
              label: `${c.code} — ${name(c)} · ${t(`expenses.groups.${c.group}`)}`,
            }))}
            centres={o.centres.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))}
            suppliers={o.suppliers.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
          />
        </Card>
      )}
    </>
  );
}
