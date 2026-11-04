import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CategoryForm, CostCentreForm } from "@/components/finance/expense-forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { canSeeExpenses, expenseFormOptions, expenseSetup } from "@/modules/finance/expenses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { archiveSetupAction, createCategoryAction, createCentreAction } from "../actions";

/** Expense categories (with their P&L group) and cost centres (ADR-109). */
export default async function ExpenseSetupPage({
  params,
}: PageProps<"/o/[orgSlug]/finance/expenses/setup">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeExpenses(ctx)) notFound();
  const [t, locale, s, o] = await Promise.all([
    getTranslations(),
    getLocale(),
    expenseSetup(ctx),
    expenseFormOptions(ctx),
  ]);
  const name = (x: { name: string; nameAr?: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  const archive = (kind: "COST_CENTRE" | "CATEGORY", id: string, archived: boolean) =>
    s.canManage ? (
      <ConfirmActionButton
        action={archiveSetupAction.bind(null, orgSlug, kind, id, !archived)}
        label={archived ? t("common.restore") : t("common.archive")}
        variant="secondary"
      />
    ) : null;
  return (
    <>
      <PageHeader title={t("expenses.setupTitle")} description={t("expenses.setupHint")} />
      <div className="space-y-6">
        <Card title={t("expenses.categories")}>
          {s.categories.length === 0 ? (
            <EmptyState title={t("expenses.noCategories")} />
          ) : (
            <Table label={t("expenses.categories")}>
              <thead>
                <tr>
                  <Th>{t("expenses.code")}</Th>
                  <Th>{t("expenses.name")}</Th>
                  <Th>{t("expenses.group")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {s.categories.map((c) => (
                  <tr key={c.id}>
                    <Td className="ltr-value font-mono text-xs">{c.code}</Td>
                    <Td>
                      {name(c)}
                      {c.archivedAt ? <Badge tone="muted">{t("common.archived")}</Badge> : null}
                    </Td>
                    <Td>{t(`expenses.groups.${c.group}`)}</Td>
                    <Td>{archive("CATEGORY", c.id, !!c.archivedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {s.canManage ? (
            <div className="border-border mt-4 border-t pt-4">
              <CategoryForm action={createCategoryAction.bind(null, orgSlug)} />
            </div>
          ) : null}
        </Card>
        <Card title={t("expenses.costCentres")}>
          {s.centres.length === 0 ? (
            <EmptyState title={t("expenses.noCentres")} />
          ) : (
            <Table label={t("expenses.costCentres")}>
              <thead>
                <tr>
                  <Th>{t("expenses.code")}</Th>
                  <Th>{t("expenses.name")}</Th>
                  <Th>{t("expenses.branch")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {s.centres.map((c) => (
                  <tr key={c.id}>
                    <Td className="ltr-value font-mono text-xs">{c.code}</Td>
                    <Td>
                      {c.name}
                      {c.archivedAt ? <Badge tone="muted">{t("common.archived")}</Badge> : null}
                    </Td>
                    <Td>
                      {c.branch ? `${c.branch.code} — ${c.branch.name}` : t("expenses.shared")}
                    </Td>
                    <Td>{archive("COST_CENTRE", c.id, !!c.archivedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {s.canManage ? (
            <div className="border-border mt-4 border-t pt-4">
              <CostCentreForm
                action={createCentreAction.bind(null, orgSlug)}
                branches={o.branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
              />
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
