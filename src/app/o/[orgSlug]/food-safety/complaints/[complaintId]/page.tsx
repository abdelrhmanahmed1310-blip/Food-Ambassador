import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { TextActionForm } from "@/components/foodsafety/quality-forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getComplaint } from "@/modules/foodsafety/quality";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName } from "@/server/inventory-view";
import {
  investigateComplaintAction,
  raiseComplaintNcAction,
  resolveComplaintAction,
} from "../../quality-actions";

export default async function ComplaintPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/complaints/[complaintId]">) {
  const { orgSlug, complaintId } = await params;
  if (!isUuid(complaintId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const { complaint: c, lot, can } = await notFoundOnAppError(getComplaint(ctx, complaintId));
  const [t, locale, format] = await Promise.all([getTranslations(), getLocale(), getFormatter()]);
  const when = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  return (
    <>
      <PageHeader
        title={`${c.number} — ${t(`complaints.categories.${c.category}`)}`}
        description={`${c.branch.code} — ${c.branch.name} · ${t(`complaints.channels.${c.channel}`)}`}
        actions={
          <Badge
            tone={
              c.status === "RESOLVED"
                ? "success"
                : c.status === "INVESTIGATING"
                  ? "warning"
                  : "danger"
            }
          >
            {t(`complaints.statuses.${c.status}`)}
          </Badge>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("complaints.receivedOn"), value: when(c.receivedAt) },
              { label: t("complaints.description"), value: c.description },
              {
                label: t("complaints.product"),
                value: c.product ? (
                  <>
                    {productName(c.product, locale)}{" "}
                    <span className="ltr-value text-muted font-mono text-xs">{c.product.sku}</span>
                  </>
                ) : (
                  "—"
                ),
              },
              {
                label: t("complaints.lot"),
                value: lot ? (
                  <Link
                    href={`/o/${orgSlug}/traceability/lots/${lot.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {lot.lotCode}
                  </Link>
                ) : (
                  "—"
                ),
              },
              { label: t("complaints.orderReference"), value: c.orderReference ?? "—" },
              {
                label: t("complaints.customer"),
                value: [c.customerName, c.customerContact].filter(Boolean).join(" · ") || "—",
              },
              {
                label: t("complaints.nonConformance"),
                value: c.nonConformance ? (
                  <Link
                    href={`/o/${orgSlug}/food-safety/non-conformances/${c.nonConformance.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {c.nonConformance.number}
                  </Link>
                ) : (
                  "—"
                ),
              },
              { label: t("complaints.investigation"), value: c.investigation ?? "—" },
              { label: t("complaints.resolution"), value: c.resolution ?? "—" },
              { label: t("complaints.customerResponse"), value: c.customerResponse ?? "—" },
              ...(c.resolvedAt
                ? [{ label: t("complaints.resolvedAt"), value: when(c.resolvedAt) }]
                : []),
            ]}
          />
        </Card>
        {can.investigate || can.raiseNc ? (
          <Card title={t("complaints.investigateTitle")}>
            {can.investigate ? (
              <TextActionForm
                action={investigateComplaintAction.bind(null, orgSlug, c.id)}
                name="investigation"
                label={t("complaints.investigation")}
                submitLabel={t("complaints.saveInvestigation")}
              />
            ) : null}
            {can.raiseNc ? (
              <div className="mt-4">
                <ConfirmActionButton
                  action={raiseComplaintNcAction.bind(null, orgSlug, c.id)}
                  label={t("complaints.raiseNc")}
                  variant="secondary"
                />
              </div>
            ) : null}
          </Card>
        ) : null}
        {can.resolve ? (
          <Card title={t("complaints.resolveTitle")}>
            <TextActionForm
              action={resolveComplaintAction.bind(null, orgSlug, c.id)}
              name="resolution"
              label={t("complaints.resolution")}
              submitLabel={t("complaints.resolve")}
              extra={{ name: "customerResponse", label: t("complaints.customerResponse") }}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
