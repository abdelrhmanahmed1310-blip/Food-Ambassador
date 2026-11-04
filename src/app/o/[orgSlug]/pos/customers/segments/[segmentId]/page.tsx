import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { segmentMembers } from "@/modules/crm/segments";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { archiveSegmentAction } from "../actions";

/** A segment's customers today (ADR-118). */
export default async function SegmentPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/customers/segments/[segmentId]">) {
  const { orgSlug, segmentId } = await params;
  const ctx = await requireTenant(orgSlug);
  const r = await notFoundOnAppError(segmentMembers(ctx, segmentId));
  const [t, fmt] = await Promise.all([getTranslations(), moneyFormatter(ctx.baseCurrency)]);
  return (
    <>
      <PageHeader
        title={r.segment.name}
        description={r.segment.description ?? t("crm.membersHint")}
        actions={
          r.canManage ? (
            <span className="flex flex-wrap gap-2">
              <a
                href={`/o/${orgSlug}/pos/customers/segments/${r.segment.id}/export`}
                className={buttonClass("secondary")}
              >
                {t("reports.downloadCsv")}
              </a>
              <ConfirmActionButton
                action={archiveSegmentAction.bind(null, orgSlug, r.segment.id)}
                label={t("crm.archive")}
                variant="secondary"
              />
            </span>
          ) : null
        }
      />
      <p className="text-muted mb-4 text-sm" data-testid="segment-count">
        {t("crm.memberCount", {
          count: r.members.length,
          consent: r.members.filter((m) => m.marketingConsent).length,
        })}
      </p>
      {r.members.length === 0 ? (
        <EmptyState title={t("crm.noMembers")} />
      ) : (
        <Table label={r.segment.name}>
          <thead>
            <tr>
              <Th>{t("crm.name")}</Th>
              <Th>{t("crm.phone")}</Th>
              <Th>{t("crm.orders")}</Th>
              <Th>{t("crm.spend")}</Th>
              <Th>{t("crm.lastVisit")}</Th>
              <Th>{t("crm.consent")}</Th>
            </tr>
          </thead>
          <tbody>
            {r.members.map((m) => (
              <tr key={m.customerId}>
                <Td>{m.person.name}</Td>
                <Td>
                  <span className="ltr-value">{m.person.phone ?? "—"}</span>
                </Td>
                <Td>{m.orders}</Td>
                <Td>
                  <span className="ltr-value">{fmt.money(m.spend)}</span>
                </Td>
                <Td>
                  <span className="ltr-value">{m.lastVisit ?? "—"}</span>
                </Td>
                <Td>{m.marketingConsent ? t("common.yes") : t("common.no")}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
