import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { EscalateForm, ReviewForm } from "@/components/crm/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { hasPermission } from "@/modules/access/authorize";
import { listFeedback } from "@/modules/crm/feedback";
import { COMPLAINT_CATEGORIES } from "@/modules/foodsafety/quality";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { escalateFeedbackAction, reviewFeedbackAction } from "../segments/actions";

/** What guests said about their orders, by branch (ADR-118). */
export default async function FeedbackPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/pos/customers/feedback">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "customers.view")) notFound();
  const low = sp.low === "1";
  const [t, format, r] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listFeedback(ctx, { from: sp.from, to: sp.to, low: low ? "1" : "" }),
  ]);
  const avg = (v: { toFixed(n: number): string } | null) => (v === null ? "—" : v.toFixed(1));
  const pct = (v: { times(n: number): { toFixed(n: number): string } } | null) =>
    v === null ? "—" : `${v.times(100).toFixed(0)}%`;
  const categories = COMPLAINT_CATEGORIES.map((c) => ({
    value: c,
    label: t(`complaints.categories.${c}`),
  }));
  return (
    <>
      <PageHeader title={t("crm.feedbackTitle")} description={t("crm.feedbackHint")} />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("tax.from")}</span>
            <input
              type="date"
              name="from"
              defaultValue={r.from}
              className={`${inputClass} w-auto`}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("tax.to")}</span>
            <input type="date" name="to" defaultValue={r.to} className={`${inputClass} w-auto`} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="low" value="1" defaultChecked={low} />
            {t("crm.lowOnly")}
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("trade.show")}
          </button>
        </form>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="feedback-summary">
          {[
            [t("crm.ratings"), String(r.summary.count)],
            [t("crm.average"), avg(r.summary.average)],
            [t("crm.happyShare"), pct(r.summary.happyShare)],
            [t("crm.lowCount"), String(r.summary.distribution[0] + r.summary.distribution[1])],
          ].map(([label, value]) => (
            <div key={label} className="border-border bg-surface rounded-xl border p-4 shadow-sm">
              <p className="text-muted text-xs font-medium">{label}</p>
              <p className="ltr-value mt-1 text-lg font-semibold">{value}</p>
            </div>
          ))}
        </div>
        {r.byBranch.length > 1 ? (
          <Table label={t("crm.byBranch")}>
            <thead>
              <tr>
                <Th>{t("crm.branch")}</Th>
                <Th>{t("crm.ratings")}</Th>
                <Th>{t("crm.average")}</Th>
                <Th>{t("crm.happyShare")}</Th>
              </tr>
            </thead>
            <tbody>
              {r.byBranch.map((b) => (
                <tr key={b.branchId}>
                  <Td>{b.branch.code}</Td>
                  <Td>{b.count}</Td>
                  <Td>{avg(b.average)}</Td>
                  <Td>{pct(b.happyShare)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        {r.rows.length === 0 ? (
          <EmptyState title={t("crm.noFeedback")} />
        ) : (
          <ul className="space-y-3">
            {r.rows.map((f) => (
              <li key={f.id}>
                <Card>
                  <div
                    className="flex flex-wrap items-center justify-between gap-2"
                    data-testid={`feedback-${f.posOrder.number}`}
                  >
                    <p className="font-medium">
                      <span aria-label={t("feedback.stars", { count: f.rating })}>
                        {"★".repeat(f.rating)}
                        {"☆".repeat(5 - f.rating)}
                      </span>{" "}
                      <span className="ltr-value text-muted text-xs">{f.posOrder.number}</span> ·{" "}
                      {f.branch.code} ·{" "}
                      {format.dateTime(f.submittedAt, { dateStyle: "short", timeStyle: "short" })}
                    </p>
                    {f.complaint ? (
                      <Badge tone="danger">
                        {t("crm.escalated", { number: f.complaint.number })}
                      </Badge>
                    ) : f.reviewedAt ? (
                      <Badge tone="muted">{t("crm.reviewed")}</Badge>
                    ) : f.rating <= 2 ? (
                      <Badge tone="warning">{t("crm.toReview")}</Badge>
                    ) : null}
                  </div>
                  {f.comment ? <p className="mt-2 whitespace-pre-line">{f.comment}</p> : null}
                  {f.reviewNote ? <p className="text-muted mt-1 text-sm">{f.reviewNote}</p> : null}
                  {r.canManage && !f.reviewedAt && f.rating <= 3 ? (
                    <div className="mt-3 grid gap-4 lg:grid-cols-2">
                      <ReviewForm action={reviewFeedbackAction.bind(null, orgSlug, f.id)} />
                      <EscalateForm
                        action={escalateFeedbackAction.bind(null, orgSlug, f.id)}
                        categories={categories}
                      />
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
