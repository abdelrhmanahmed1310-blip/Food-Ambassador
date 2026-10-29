import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ReverseForm } from "@/components/inventory/forms";
import { MovementsTable } from "@/components/inventory/movements-table";
import { Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getDocument } from "@/modules/inventory/queries";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { reverseDocumentAction } from "../../actions";

export default async function DocumentPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/documents/[documentId]">) {
  const { orgSlug, documentId } = await params;
  if (!isUuid(documentId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const doc = await notFoundOnAppError(getDocument(ctx, documentId));
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const base = `/o/${orgSlug}/inventory/documents`;
  const rows = doc.entries.map((e) => ({ ...e, postedByName: doc.postedByName }));
  return (
    <>
      <PageHeader
        title={doc.number}
        description={t(`inventory.documentTypes.${doc.type}`)}
        actions={
          doc.reversedBy ? (
            <Badge tone="muted">
              {t("inventory.reversedBy", { number: doc.reversedBy.number })}
            </Badge>
          ) : undefined
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("common.warehouse"),
                value: `${doc.warehouse.code} — ${doc.warehouse.name}`,
              },
              ...(doc.destination && doc.destinationWarehouseId !== doc.warehouseId
                ? [
                    {
                      label: t("inventory.destination"),
                      value: `${doc.destination.code} — ${doc.destination.name}`,
                    },
                  ]
                : []),
              {
                label: t("common.date"),
                value: format.dateTime(doc.postedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: ctx.timeZone,
                }),
              },
              { label: t("common.by"), value: doc.postedByName ?? "—" },
              {
                label: t("common.reason"),
                value: doc.reasonCode
                  ? t.has(`inventory.reasons.${doc.reasonCode}`)
                    ? t(`inventory.reasons.${doc.reasonCode}`)
                    : doc.reasonCode
                  : "—",
              },
              { label: t("common.note"), value: doc.note ?? "—" },
              ...(doc.reverses
                ? [
                    {
                      label: t("inventory.reverses", { number: "" }),
                      value: (
                        <Link
                          className="ltr-value text-primary font-mono hover:underline"
                          href={`${base}/${doc.reverses.id}`}
                        >
                          {doc.reverses.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...(doc.reversedBy
                ? [
                    {
                      label: t("inventory.reversedBy", { number: "" }),
                      value: (
                        <Link
                          className="ltr-value text-primary font-mono hover:underline"
                          href={`${base}/${doc.reversedBy.id}`}
                        >
                          {doc.reversedBy.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...(doc.stockCount
                ? [
                    {
                      label: t("inventory.countNumber"),
                      value: (
                        <Link
                          className="ltr-value text-primary font-mono hover:underline"
                          href={`/o/${orgSlug}/inventory/counts/${doc.stockCount.id}`}
                        >
                          {doc.stockCount.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
        <MovementsTable
          rows={rows}
          orgSlug={orgSlug}
          timeZone={ctx.timeZone}
          showDocument={false}
        />
        {doc.canReverse ? (
          <Card title={t("inventory.reverse")}>
            <p className="text-muted mb-3 text-sm">{t("inventory.reverseHint")}</p>
            <ReverseForm action={reverseDocumentAction.bind(null, orgSlug, doc.id)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
