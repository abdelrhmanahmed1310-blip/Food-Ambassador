import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SegmentForm } from "@/components/crm/forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listSegments, rfmOverview } from "@/modules/crm/segments";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { withTenantTx } from "@/server/db/transactions";
import { moneyFormatter } from "@/server/inventory-view";
import { saveSegmentAction } from "./actions";

/** Saved groups of guests, worked out from their orders today (ADR-118). */
export default async function SegmentsPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/customers/segments">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "customers.view")) notFound();
  const [t, list, rfm, branches] = await Promise.all([
    getTranslations(),
    listSegments(ctx),
    rfmOverview(ctx),
    withTenantTx(ctx.organizationId, (tx) =>
      tx.branch.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true },
        orderBy: { code: "asc" },
      }),
    ),
  ]);
  const fmt = await moneyFormatter(ctx.baseCurrency);
  const base = `/o/${orgSlug}/pos/customers/segments`;
  const rules = (r: (typeof list.segments)[number]["rules"]) =>
    [
      t("crm.r.window", { days: r.windowDays }),
      r.visitedWithinDays !== undefined
        ? t("crm.r.visitedWithin", { days: r.visitedWithinDays })
        : null,
      r.notVisitedForDays !== undefined
        ? t("crm.r.notVisitedFor", { days: r.notVisitedForDays })
        : null,
      r.minOrders !== undefined ? t("crm.r.minOrders", { n: r.minOrders }) : null,
      r.maxOrders !== undefined ? t("crm.r.maxOrders", { n: r.maxOrders }) : null,
      r.minSpend !== undefined ? t("crm.r.minSpend", { amount: r.minSpend }) : null,
      r.minPoints !== undefined ? t("crm.r.minPoints", { n: r.minPoints }) : null,
      r.branchIds?.length ? t("crm.r.branches", { n: r.branchIds.length }) : null,
      r.consentOnly ? t("crm.r.consent") : null,
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <>
      <PageHeader title={t("crm.segmentsTitle")} description={t("crm.segmentsHint")} />
      <div className="space-y-6">
        <Card title={t("crm.rfmTitle", { days: rfm.windowDays })}>
          <p className="text-muted mb-3 text-sm">{t("crm.rfmHint")}</p>
          <Table label={t("crm.rfmTitle", { days: rfm.windowDays })}>
            <thead>
              <tr>
                <Th>{t("crm.group")}</Th>
                <Th>{t("crm.customers")}</Th>
                <Th>{t("crm.spend")}</Th>
                <Th>{t("crm.withConsent")}</Th>
              </tr>
            </thead>
            <tbody>
              {rfm.groups.map((g) => (
                <tr key={g.group} data-testid={`rfm-${g.group}`}>
                  <Td>{t(`crm.groups.${g.group}`)}</Td>
                  <Td>{g.customers}</Td>
                  <Td>
                    <span className="ltr-value">{fmt.money(g.spend)}</span>
                  </Td>
                  <Td>{g.withConsent}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title={t("crm.saved")}>
          {list.segments.length === 0 ? (
            <EmptyState title={t("crm.noSegments")} />
          ) : (
            <Table label={t("crm.saved")}>
              <thead>
                <tr>
                  <Th>{t("crm.name")}</Th>
                  <Th>{t("crm.conditions")}</Th>
                  <Th>{t("crm.customers")}</Th>
                  <Th>{t("crm.withConsent")}</Th>
                </tr>
              </thead>
              <tbody>
                {list.segments.map((s) => (
                  <tr key={s.id} data-testid={`segment-${s.name}`}>
                    <Td>
                      <Link href={`${base}/${s.id}`} className="text-primary hover:underline">
                        {s.name}
                      </Link>
                    </Td>
                    <Td>
                      <span className="text-muted text-xs">{rules(s.rules)}</span>
                    </Td>
                    <Td>{s.count}</Td>
                    <Td>{s.withConsent}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {list.canManage ? (
          <Card title={t("crm.newSegment")}>
            <SegmentForm
              action={saveSegmentAction.bind(null, orgSlug)}
              branches={branches.map((b) => ({ value: b.id, label: b.code }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
