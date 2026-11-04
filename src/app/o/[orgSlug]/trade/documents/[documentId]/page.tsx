import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { TextReasonForm } from "@/components/invoices/forms";
import { TradeDocumentForm } from "@/components/trade/forms";
import { Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { getTradeDocument } from "@/modules/trade/documents";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { archiveTradeDocumentAction, renewTradeDocumentAction } from "../actions";

const TONE = {
  NO_EXPIRY: "muted",
  VALID: "success",
  EXPIRING: "warning",
  EXPIRED: "danger",
} as const;

/** One trade document: details, renewal, removal and its scan (ADR-114). */
export default async function TradeDocumentPage({
  params,
}: PageProps<"/o/[orgSlug]/trade/documents/[documentId]">) {
  const { orgSlug, documentId } = await params;
  const ctx = await requireTenant(orgSlug);
  const d = await notFoundOnAppError(getTradeDocument(ctx, documentId));
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const typeName = (locale === "ar" && d.documentType.nameAr) || d.documentType.name;
  return (
    <>
      <PageHeader
        title={`${d.documentType.code} — ${typeName}`}
        description={t(`tradeDocs.scopeHints.${d.documentType.scope}`)}
        actions={
          d.archivedAt ? (
            <Badge tone="muted">{t("tradeDocs.removed")}</Badge>
          ) : d.state ? (
            <Badge tone={TONE[d.state]}>{t(`tradeDocs.states.${d.state}`)}</Badge>
          ) : null
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("tradeDocs.heldFor"),
                value: d.product ? (
                  `${d.product.sku} — ${d.product.nameEn}`
                ) : d.shipment ? (
                  <Link
                    href={`/o/${orgSlug}/trade/shipments/${d.shipment.id}`}
                    className="ltr-value text-primary hover:underline"
                  >
                    {d.shipment.number}
                  </Link>
                ) : (
                  "—"
                ),
              },
              {
                label: t("tradeDocs.number"),
                value: <span className="ltr-value">{d.number ?? "—"}</span>,
              },
              { label: t("tradeDocs.issuedBy"), value: d.issuedBy ?? "—" },
              {
                label: t("tradeDocs.issuedOn"),
                value: <span className="ltr-value">{d.issuedOn ?? "—"}</span>,
              },
              {
                label: t("tradeDocs.expiresOn"),
                value: <span className="ltr-value">{d.expiresOn ?? "—"}</span>,
              },
              { label: t("tradeDocs.note"), value: d.note ?? "—" },
              ...(d.archiveReason
                ? [{ label: t("tradeDocs.removeReason"), value: d.archiveReason }]
                : []),
            ]}
          />
        </Card>
        <AttachmentsCard ctx={ctx} orgSlug={orgSlug} entityType="TRADE_DOCUMENT" entityId={d.id} />
        {d.canManage ? (
          <>
            <Card title={t("tradeDocs.renew")}>
              <TradeDocumentForm
                action={renewTradeDocumentAction.bind(null, orgSlug, d.id)}
                submitLabel={t("tradeDocs.renew")}
                defaults={{
                  number: d.number ?? "",
                  issuedBy: d.issuedBy ?? "",
                  issuedOn: d.issuedOn ?? "",
                  expiresOn: d.expiresOn ?? "",
                  note: d.note ?? "",
                }}
              />
            </Card>
            <Card title={t("tradeDocs.remove")}>
              <TextReasonForm
                action={archiveTradeDocumentAction.bind(null, orgSlug, d.id)}
                name="reason"
                label={t("tradeDocs.removeReason")}
                submitLabel={t("tradeDocs.remove")}
                variant="danger"
              />
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
