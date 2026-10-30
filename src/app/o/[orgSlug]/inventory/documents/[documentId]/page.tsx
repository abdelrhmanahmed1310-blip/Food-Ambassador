import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ReverseForm } from "@/components/inventory/forms";
import { MovementsTable } from "@/components/inventory/movements-table";
import { Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getDocument } from "@/modules/inventory/queries";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";
import { reverseDocumentAction } from "../../actions";

export default async function DocumentPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/documents/[documentId]">) {
  const { orgSlug, documentId } = await params;
  if (!isUuid(documentId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const doc = await notFoundOnAppError(getDocument(ctx, documentId));
  const [t, format, locale, fmt, money] = await Promise.all([
    getTranslations(),
    getFormatter(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
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
              ...(doc.receipt
                ? [
                    {
                      label: t("purchasing.receiptTitle"),
                      value: (
                        <Link
                          className="ltr-value text-primary font-mono hover:underline"
                          href={`/o/${orgSlug}/purchasing/receipts/${doc.receipt.id}`}
                        >
                          {doc.receipt.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...(doc.landedCost
                ? [
                    {
                      label: t("landedCost.charge"),
                      value: (
                        <>
                          {t(`landedCost.charges.${doc.landedCost.chargeType}`)}
                          {doc.landedCost.amount !== null ? (
                            <>
                              {" "}
                              <span className="ltr-value tabular-nums">
                                {money.money(doc.landedCost.amount)}
                              </span>
                            </>
                          ) : null}
                        </>
                      ),
                    },
                    {
                      label: t("purchasing.receiptTitle"),
                      value: (
                        <Link
                          className="ltr-value text-primary font-mono hover:underline"
                          href={`/o/${orgSlug}/purchasing/receipts/${doc.landedCost.receipt.id}`}
                        >
                          {doc.landedCost.receipt.number}
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
        {doc.revaluation ? (
          <Card title={t("inventory.revalue")}>
            <DescriptionList
              items={[
                {
                  label: t("inventory.product"),
                  value: `${doc.revaluation.product.sku} — ${productName(doc.revaluation.product, locale)}`,
                },
                {
                  label: t("inventory.quantity"),
                  value: (
                    <span className="ltr-value tabular-nums">
                      {fmt(doc.revaluation.quantity)} {doc.revaluation.product.baseUom.code}
                    </span>
                  ),
                },
                {
                  label: t("inventory.previousCost"),
                  value: doc.revaluation.previousUnitCost
                    ? money.unitCost(doc.revaluation.previousUnitCost)
                    : t("inventory.noAverage"),
                },
                {
                  label: t("inventory.newUnitCost"),
                  value: money.unitCost(doc.revaluation.newUnitCost),
                },
                {
                  label: t("inventory.previousValue"),
                  value: money.money(doc.revaluation.previousValue),
                },
                { label: t("inventory.newValue"), value: money.money(doc.revaluation.newValue) },
                {
                  label: t("inventory.valueChange"),
                  value: money.money(doc.revaluation.valueDelta),
                },
              ]}
            />
          </Card>
        ) : null}
        {rows.length > 0 ? (
          <MovementsTable
            rows={rows}
            orgSlug={orgSlug}
            timeZone={ctx.timeZone}
            currency={ctx.baseCurrency}
            showDocument={false}
          />
        ) : null}
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
