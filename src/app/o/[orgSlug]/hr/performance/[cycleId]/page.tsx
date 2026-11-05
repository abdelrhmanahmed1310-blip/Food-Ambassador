import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import {
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { canViewPerformance, getCycle } from "@/modules/performance/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { closeCycleAction, launchCycleAction } from "../actions";
import { CYCLE_TONE, REVIEW_TONE } from "../status";

export default async function CyclePage({
  params,
}: PageProps<"/o/[orgSlug]/hr/performance/[cycleId]">) {
  const { orgSlug, cycleId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewPerformance(ctx) || !isUuid(cycleId)) notFound();
  const [t, d] = await Promise.all([getTranslations("performance"), getCycle(ctx, cycleId)]);
  const c = d.cycle;
  const rated = Object.values(d.distribution).reduce((a, b) => a + b, 0);
  return (
    <>
      <PageHeader
        title={c.name}
        description={`${c.periodStart} → ${c.periodEnd}`}
        actions={<Badge tone={CYCLE_TONE[c.status]}>{t(`cycleStatuses.${c.status}`)}</Badge>}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("selfDueOn"), value: <span className="ltr-value">{c.selfDueOn}</span> },
              {
                label: t("managerDueOn"),
                value: <span className="ltr-value">{c.managerDueOn}</span>,
              },
              ...Object.entries(d.byStatus).map(([k, v]) => ({
                label: t(`reviewStatuses.${k}`),
                value: String(v),
              })),
            ]}
          />
        </Card>
        {rated > 0 ? (
          <Card title={t("distribution")}>
            <ul className="space-y-1 text-sm" data-testid="rating-distribution">
              {([5, 4, 3, 2, 1] as const).map((r) => (
                <li key={r} className="flex items-center gap-3">
                  <span className="w-40">
                    {r} — {t(`ratings.${r}`)}
                  </span>
                  <span
                    className="bg-primary h-3 rounded"
                    style={{ width: `${(d.distribution[r] / rated) * 200}px` }}
                  />
                  <span className="tabular-nums">{d.distribution[r]}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {d.reviews.length === 0 ? (
          <EmptyState title={c.status === "DRAFT" ? t("notLaunched") : t("noReviews")} />
        ) : (
          <Table label={t("reviews")}>
            <thead>
              <tr>
                <Th>{t("employee")}</Th>
                <Th>{t("reviewer")}</Th>
                <Th>{t("rating")}</Th>
                <Th>{t("status")}</Th>
              </tr>
            </thead>
            <tbody>
              {d.reviews.map((r) => (
                <tr key={r.id} data-testid={`review-${r.employee.number}`}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/hr/performance/reviews/${r.id}`}
                      className="text-primary hover:underline"
                    >
                      {r.employee.firstName} {r.employee.lastName}
                    </Link>
                    <span className="text-muted block text-xs">
                      {r.employee.branch.code} · {r.employee.jobTitle}
                    </span>
                  </Td>
                  <Td>
                    {r.reviewer ? `${r.reviewer.firstName} ${r.reviewer.lastName}` : t("hrReviews")}
                  </Td>
                  <Td className="tabular-nums">{r.finalRating ?? r.managerRating ?? "—"}</Td>
                  <Td>
                    <Badge tone={REVIEW_TONE[r.status]}>{t(`reviewStatuses.${r.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {d.canManage && c.status === "DRAFT" ? (
          <ConfirmActionButton
            action={launchCycleAction.bind(null, orgSlug, c.id)}
            label={t("launch")}
            confirmMessage={t("launchConfirm")}
            variant="primary"
          />
        ) : null}
        {d.canManage && c.status === "OPEN" ? (
          <ConfirmActionButton
            action={closeCycleAction.bind(null, orgSlug, c.id)}
            label={t("close")}
            variant="secondary"
          />
        ) : null}
      </div>
    </>
  );
}
