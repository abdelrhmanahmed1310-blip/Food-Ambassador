import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { PostRevaluationForm } from "@/components/fx/revaluation-forms";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isCalendarDate } from "@/lib/dates";
import { hasPermission } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import { listRevaluations, previewRevaluation } from "@/modules/invoices/revaluation";
import { listCompanies } from "@/modules/organizations/companies";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { AppError } from "@/server/errors";
import { moneyIn } from "@/server/fx-view";
import { postRevaluationAction } from "./actions";

const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function RevaluationPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/payables/revaluation">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "invoices.view")) notFound();
  const canPost = hasPermission(ctx.grants, "fx.manage");
  const today = businessDate(ctx.timeZone);
  const asOf =
    typeof sp.asOf === "string" && isCalendarDate(sp.asOf) && sp.asOf <= today ? sp.asOf : today;
  const [t, tr, locale, runs, companies] = await Promise.all([
    getTranslations(),
    getTranslations("rules"),
    getLocale(),
    listRevaluations(ctx),
    listCompanies(ctx),
  ]);
  // One company at a time, in its currency (ADR-086).
  const company =
    companies.find((c) => c.id === sp.companyId) ?? companies.find((c) => c.isDefault)!;
  let preview: Awaited<ReturnType<typeof previewRevaluation>> | null = null;
  let problem: string | null = null;
  if (canPost) {
    try {
      preview = await previewRevaluation(ctx, asOf, company.id);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      const rule = (e.details as { rule?: string } | undefined)?.rule ?? e.code;
      problem = tr.has(rule) ? tr(rule, e.details as Record<string, string>) : e.message;
    }
  }
  const money = await moneyIn([company.currency, ...(preview?.lines ?? []).map((l) => l.currency)]);
  const base = money(company.currency);
  const posted = runs.find(
    (r) => !r.cancelledAt && day(r.asOf) === asOf && r.companyId === company.id,
  );
  return (
    <>
      <PageHeader title={t("revaluation.title")} description={t("revaluation.intro")} />
      <div className="space-y-6">
        {canPost ? (
          <Card title={t("revaluation.preview")}>
            <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t("revaluation.asOf")}</span>
                {companies.length > 1 ? (
                  <select
                    name="companyId"
                    defaultValue={company.id}
                    aria-label={t("companies.company")}
                    className="border-border bg-surface me-2 rounded-md border px-3 py-2"
                  >
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} — {c.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  type="date"
                  name="asOf"
                  max={today}
                  defaultValue={asOf}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                />
              </label>
              <button
                type="submit"
                className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
              >
                {t("common.apply")}
              </button>
            </form>
            {problem ? (
              <Alert tone="error">{problem}</Alert>
            ) : preview && preview.lines.length === 0 ? (
              <EmptyState title={t("revaluation.nothing")} />
            ) : preview ? (
              <div className="space-y-4">
                <Table label={t("revaluation.preview")}>
                  <thead>
                    <tr>
                      <Th>{t("revaluation.party")}</Th>
                      <Th>{t("fx.currency")}</Th>
                      <Th>{t("revaluation.open")}</Th>
                      <Th>{t("revaluation.booked")}</Th>
                      <Th>{t("revaluation.rate")}</Th>
                      <Th>{t("revaluation.revalued")}</Th>
                      <Th>{t("revaluation.difference")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={`${l.kind}-${l.party.id}-${l.currency}`}>
                        <Td>
                          <Badge tone="neutral">{t(`revaluation.kinds.${l.kind}`)}</Badge>{" "}
                          <span className="ltr-value font-mono text-xs">{l.party.code}</span>{" "}
                          <bdi>{(locale === "ar" && l.party.nameAr) || l.party.name}</bdi>
                        </Td>
                        <Td>
                          <span className="ltr-value font-mono text-xs">{l.currency}</span>
                        </Td>
                        <Td className="tabular-nums">
                          <span className="ltr-value">{money(l.currency).money(l.openAmount)}</span>
                        </Td>
                        <Td className="tabular-nums">
                          <span className="ltr-value">{base.money(l.bookedBase)}</span>
                        </Td>
                        <Td className="tabular-nums">
                          <span className="ltr-value">
                            {l.rate.toFixed().replace(/\.?0+$/, "")} ({l.rateDate})
                          </span>
                        </Td>
                        <Td className="tabular-nums">
                          <span className="ltr-value">{base.money(l.revaluedBase)}</span>
                        </Td>
                        <Td className="tabular-nums">
                          <span className="ltr-value">{base.money(l.differenceBase)}</span>
                        </Td>
                      </tr>
                    ))}
                    {(
                      [
                        ["PAYABLE", preview.payablesTotal],
                        ["RECEIVABLE", preview.receivablesTotal],
                      ] as const
                    ).map(([kind, total]) => (
                      <tr
                        key={kind}
                        className="font-medium"
                        data-testid={`revaluation-total-${kind}`}
                      >
                        <Td>{t(`revaluation.totals.${kind}`)}</Td>
                        <Td />
                        <Td />
                        <Td />
                        <Td />
                        <Td />
                        <Td className="tabular-nums">
                          <span className="ltr-value">{base.money(total)}</span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <p className="text-muted text-xs">{t("revaluation.sign")}</p>
                {posted ? (
                  <Alert tone="info">
                    {t("revaluation.alreadyPosted", { number: posted.number })}
                  </Alert>
                ) : (
                  <PostRevaluationForm
                    action={postRevaluationAction.bind(null, orgSlug, asOf, company.id)}
                  />
                )}
              </div>
            ) : null}
          </Card>
        ) : null}
        <Card title={t("revaluation.history")}>
          {runs.length === 0 ? (
            <EmptyState title={t("revaluation.noRuns")} />
          ) : (
            <Table label={t("revaluation.history")}>
              <thead>
                <tr>
                  <Th>{t("revaluation.number")}</Th>
                  <Th>{t("revaluation.asOf")}</Th>
                  <Th>{t("revaluation.difference")}</Th>
                  <Th>{t("revaluation.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/purchasing/payables/revaluation/${r.id}`}
                        className="ltr-value text-primary font-mono hover:underline"
                      >
                        {r.number}
                      </Link>
                    </Td>
                    <Td>
                      <span className="ltr-value">{day(r.asOf)}</span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">{base.money(r.totalDifferenceBase)}</span>
                    </Td>
                    <Td>
                      <Badge tone={r.cancelledAt ? "muted" : "success"}>
                        {t(r.cancelledAt ? "revaluation.cancelled" : "revaluation.posted")}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
