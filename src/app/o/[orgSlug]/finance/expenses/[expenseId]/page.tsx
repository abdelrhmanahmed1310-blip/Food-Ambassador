import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { TextReasonForm } from "@/components/invoices/forms";
import { Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getExpense } from "@/modules/finance/expenses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { reverseExpenseAction } from "../actions";

export default async function ExpensePage({
  params,
}: PageProps<"/o/[orgSlug]/finance/expenses/[expenseId]">) {
  const { orgSlug, expenseId } = await params;
  if (!isUuid(expenseId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const e = await notFoundOnAppError(getExpense(ctx, expenseId));
  const [t, locale, format, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    moneyFormatter(e.currency),
  ]);
  const m = (v: { toString(): string }) => <span className="ltr-value">{money.money(v)}</span>;
  const dt = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  return (
    <>
      <PageHeader
        title={`${e.number} — ${e.description}`}
        description={`${e.branch.code} — ${e.branch.name}`}
        actions={
          e.status === "REVERSED" ? (
            <Badge tone="muted">{t("expenses.reversed")}</Badge>
          ) : (
            <Badge tone="success">{t("expenses.posted")}</Badge>
          )
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("expenses.date"),
                value: (
                  <span className="ltr-value">{e.expenseDate.toISOString().slice(0, 10)}</span>
                ),
              },
              {
                label: t("expenses.category"),
                value: `${e.category.code} — ${(locale === "ar" && e.category.nameAr) || e.category.name} · ${t(`expenses.groups.${e.category.group}`)}`,
              },
              {
                label: t("expenses.costCentre"),
                value: e.costCentre ? `${e.costCentre.code} — ${e.costCentre.name}` : "—",
              },
              {
                label: t("expenses.supplier"),
                value: e.supplier ? (
                  <Link
                    href={`/o/${orgSlug}/suppliers/${e.supplier.id}`}
                    className="text-primary hover:underline"
                  >
                    {e.supplier.name}
                  </Link>
                ) : (
                  "—"
                ),
              },
              {
                label: t("expenses.reference"),
                value: <span className="ltr-value">{e.reference ?? "—"}</span>,
              },
              { label: t("expenses.net"), value: m(e.netAmount) },
              { label: t("expenses.tax"), value: m(e.taxAmount) },
              { label: t("expenses.gross"), value: m(e.grossAmount) },
              {
                label: t("expenses.recordedBy"),
                value: `${e.createdBy ?? "—"} · ${dt(e.createdAt)}`,
              },
              ...(e.reversedAt
                ? [
                    {
                      label: t("expenses.reversedBy"),
                      value: `${e.reversedBy ?? "—"} · ${dt(e.reversedAt)}`,
                    },
                    { label: t("expenses.reverseReason"), value: e.reverseReason ?? "" },
                  ]
                : []),
            ]}
          />
        </Card>
        <AttachmentsCard ctx={ctx} orgSlug={orgSlug} entityType="EXPENSE" entityId={e.id} />
        {e.canReverse ? (
          <Card title={t("expenses.reverse")}>
            <p className="text-muted mb-3 text-sm">{t("expenses.reverseHint")}</p>
            <TextReasonForm
              action={reverseExpenseAction.bind(null, orgSlug, e.id)}
              name="reason"
              label={t("expenses.reverseReason")}
              submitLabel={t("expenses.reverse")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
