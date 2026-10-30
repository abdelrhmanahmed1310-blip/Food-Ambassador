import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ReverseForm } from "@/components/inventory/forms";
import { ReceiptStatusBadge } from "@/components/procurement/badges";
import { LandedCostForm } from "@/components/procurement/forms";
import {
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { getReceipt } from "@/modules/procurement/receipts";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";
import { addLandedCostAction, reverseReceiptAction } from "../../actions";

export default async function ReceiptPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/receipts/[receiptId]">) {
  const { orgSlug, receiptId } = await params;
  if (!isUuid(receiptId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const receipt = await notFoundOnAppError(getReceipt(ctx, receiptId));
  const [t, locale, format, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const dt = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  const docLink = (doc: { id: string; number: string } | null) =>
    doc ? (
      <Link
        href={`/o/${orgSlug}/inventory/documents/${doc.id}`}
        className="ltr-value text-primary font-mono hover:underline"
      >
        {doc.number}
      </Link>
    ) : (
      "—"
    );
  const dec = (v: { toString(): string }) => new Decimal(v.toString());
  const landedByLine = new Map<string, Decimal>();
  for (const c of receipt.landedCosts)
    for (const l of c.lines)
      landedByLine.set(
        l.receiptLineId,
        (landedByLine.get(l.receiptLineId) ?? new Decimal(0)).plus(dec(l.allocatedAmount)),
      );
  const hasLanded = receipt.landedCosts.length > 0;
  const stockedUnits = new Set(
    receipt.lines.filter((l) => l.acceptedQuantityBase.gt(0)).map((l) => l.product.baseUom.code),
  );
  return (
    <>
      <PageHeader
        title={receipt.number}
        description={(locale === "ar" && receipt.supplier.nameAr) || receipt.supplier.name}
        actions={<ReceiptStatusBadge status={receipt.status} />}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("purchasing.ordersTitle"),
                value: (
                  <Link
                    href={`/o/${orgSlug}/purchasing/orders/${receipt.purchaseOrder.id}`}
                    className="ltr-value text-primary font-mono hover:underline"
                  >
                    {receipt.purchaseOrder.number}
                  </Link>
                ),
              },
              {
                label: t("common.warehouse"),
                value: `${receipt.warehouse.code}${receipt.location ? ` / ${receipt.location.code}` : ""} — ${receipt.warehouse.name}`,
              },
              { label: t("purchasing.receivedAt"), value: dt(receipt.receivedAt) },
              { label: t("purchasing.postedBy"), value: receipt.names.postedBy ?? "—" },
              { label: t("purchasing.deliveryNote"), value: receipt.deliveryNoteRef ?? "—" },
              { label: t("purchasing.stockDocument"), value: docLink(receipt.document) },
              { label: t("common.note"), value: receipt.note ?? "—" },
              ...(receipt.reversedAt
                ? [
                    {
                      label: t("purchasing.reversedBy"),
                      value: (
                        <>
                          <bdi>{receipt.names.reversedBy ?? "—"}</bdi> ·{" "}
                          <bdi>{dt(receipt.reversedAt)}</bdi> — <bdi>{receipt.reversalReason}</bdi>
                        </>
                      ),
                    },
                    {
                      label: t("inventory.reversedBy", { number: "" }),
                      value: docLink(receipt.reversal),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
        <Table label={t("purchasing.lines")}>
          <thead>
            <tr>
              <Th>{t("purchasing.product")}</Th>
              <Th>{t("purchasing.receivedQty")}</Th>
              <Th>{t("purchasing.accepted")}</Th>
              <Th>{t("purchasing.rejectedQty")}</Th>
              <Th>{t("purchasing.lotCode")}</Th>
              <Th>{t("purchasing.chargedPrice")}</Th>
              <Th>{t("purchasing.temperature")}</Th>
              {hasLanded ? <Th>{t("landedCost.title")}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((l) => (
              <tr key={l.id}>
                <Td>
                  {productName(l.product, locale)}
                  <span className="ltr-value text-muted block font-mono text-xs">
                    {l.product.sku}
                  </span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value whitespace-nowrap">
                    {fmt(l.receivedQuantity)} {l.uom.code}
                  </span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value whitespace-nowrap">
                    {fmt(l.acceptedQuantity)} {l.uom.code}
                  </span>
                  {l.quarantine ? (
                    <span className="mt-1 block">
                      <Badge tone="warning">{t("inventory.statuses.QUARANTINE")}</Badge>
                    </span>
                  ) : null}
                </Td>
                <Td className="tabular-nums">
                  {l.rejectedQuantity.gt(0) ? (
                    <>
                      <span className="ltr-value whitespace-nowrap">
                        {fmt(l.rejectedQuantity)} {l.uom.code}
                      </span>
                      <span className="text-muted block text-xs">
                        {l.rejectionReason
                          ? t(`purchasing.rejectionReasons.${l.rejectionReason}`)
                          : ""}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{l.lot?.lotCode ?? "—"}</span>
                  {l.lot?.expiresOn ? (
                    <span className="ltr-value text-muted block text-xs">
                      {l.lot.expiresOn.toISOString().slice(0, 10)}
                    </span>
                  ) : null}
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value whitespace-nowrap">{money.unitCost(l.unitPrice)}</span>
                  {!l.unitPrice.equals(l.orderedUnitPrice) ? (
                    <span className="text-muted block text-xs">
                      {t("purchasing.orderedPrice")}:{" "}
                      <span className="ltr-value">{money.unitCost(l.orderedUnitPrice)}</span>
                    </span>
                  ) : null}
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">{l.temperatureCelsius?.toFixed() ?? "—"}</span>
                </Td>
                {hasLanded ? (
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {landedByLine.has(l.id) ? money.money(landedByLine.get(l.id)!) : "—"}
                    </span>
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
        {hasLanded || receipt.canAddLandedCost ? (
          <Card title={t("landedCost.title")}>
            <p className="text-muted mb-3 text-sm">{t("landedCost.hint")}</p>
            {hasLanded ? (
              <Table label={t("landedCost.title")}>
                <thead>
                  <tr>
                    <Th>{t("purchasing.number")}</Th>
                    <Th>{t("landedCost.charge")}</Th>
                    <Th>{t("landedCost.method")}</Th>
                    <Th>{t("landedCost.amount")}</Th>
                    <Th>{t("landedCost.capitalized")}</Th>
                    <Th>{t("landedCost.expensed")}</Th>
                    <Th>{t("landedCost.reference")}</Th>
                    <Th>{t("common.date")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.landedCosts.map((c) => (
                    <tr key={c.id}>
                      <Td>{docLink(c.document)}</Td>
                      <Td>{t(`landedCost.charges.${c.chargeType}`)}</Td>
                      <Td>{t(`landedCost.methods.${c.method}`)}</Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">{money.money(c.amount)}</span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {money.money(c.capitalizedAmount)}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {money.money(c.expensedAmount)}
                        </span>
                      </Td>
                      <Td>
                        <span className="ltr-value">{c.reference ?? "—"}</span>
                      </Td>
                      <Td className="whitespace-nowrap">{dt(c.postedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
            {receipt.canAddLandedCost ? (
              <div className={hasLanded ? "mt-4" : ""}>
                <LandedCostForm
                  action={addLandedCostAction.bind(null, orgSlug, receipt.id)}
                  currency={ctx.baseCurrency}
                  quantityAllowed={stockedUnits.size === 1}
                />
              </div>
            ) : null}
          </Card>
        ) : null}
        {receipt.canReverse ? (
          <Card title={t("purchasing.reverseReceipt")}>
            <p className="text-muted mb-3 text-sm">{t("purchasing.reverseReceiptHint")}</p>
            <ReverseForm action={reverseReceiptAction.bind(null, orgSlug, receipt.id)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
