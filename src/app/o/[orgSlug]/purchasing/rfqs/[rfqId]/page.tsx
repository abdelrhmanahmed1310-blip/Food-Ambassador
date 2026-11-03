import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { OrderStatusBadge, RfqStatusBadge } from "@/components/procurement/badges";
import { ReasonForm, RequisitionLineForm } from "@/components/procurement/forms";
import { AwardForm, InviteSupplierForm, QuotationForm } from "@/components/procurement/rfq-forms";
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
import { hasPermission } from "@/modules/access/authorize";
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { currencyChoices } from "@/modules/fx/rules";
import { getRfq } from "@/modules/procurement/rfqs";
import { supplierOptions } from "@/modules/procurement/suppliers";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyIn } from "@/server/fx-view";
import {
  productName,
  productOptions,
  quantityFormatter,
  unitOptions,
} from "@/server/inventory-view";
import {
  addRfqLineAction,
  awardRfqAction,
  cancelRfqAction,
  inviteRfqSupplierAction,
  recordQuotationAction,
  removeRfqLineAction,
  removeRfqSupplierAction,
  sendRfqAction,
} from "../actions";

export default async function RfqPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/rfqs/[rfqId]">) {
  const { orgSlug, rfqId } = await params;
  if (!isUuid(rfqId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const view = await notFoundOnAppError(getRfq(ctx, rfqId));
  const { rfq, actions, lines, suppliers, quotations, orders } = view;
  const manage = view.canManage;
  const [t, locale, format, qty] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
  const moneyOf = await moneyIn([view.currency, ...quotations.map((q) => q.currency)]);
  const canCatalog = hasPermission(ctx.grants, "catalog.view");
  const [productList, units, allSuppliers] =
    manage && actions.edit && canCatalog
      ? await Promise.all([listProductOptions(ctx), listUnits(ctx), supplierOptions(ctx)])
      : [[], [], []];
  const base = `/o/${orgSlug}/purchasing/rfqs/${rfq.id}`;
  const date = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" }) : "—";
  const supplierName = (s: { name: string; nameAr: string | null }) =>
    (locale === "ar" && s.nameAr) || s.name;
  const lineLabel = (l: (typeof lines)[number]) =>
    `${l.product.sku} — ${productName(l.product, locale)}`;
  const quoted = new Set(quotations.map((q) => q.supplier.id));
  const quotationOf = (id: string) => quotations.find((q) => q.id === id)!;
  const currencies = currencyChoices(ctx.baseCurrency).map((c) => ({ value: c, label: c }));
  const quotable = lines.map((l) => ({
    id: l.id,
    label: lineLabel(l),
    quantity: qty(l.quantity),
    unit: l.uom.code,
  }));

  return (
    <>
      <PageHeader
        title={`${rfq.number} — ${rfq.title}`}
        description={`${rfq.warehouse.code} — ${rfq.warehouse.name}`}
        actions={<RfqStatusBadge status={rfq.status} />}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("rfqs.respondBy"), value: date(rfq.respondBy) },
              { label: t("rfqs.neededBy"), value: date(rfq.neededBy) },
              { label: t("rfqs.noteForSuppliers"), value: rfq.note ?? "—" },
              ...(rfq.cancelReason
                ? [{ label: t("rfqs.cancelReason"), value: rfq.cancelReason }]
                : []),
            ]}
          />
          {manage && (actions.send || actions.cancel) ? (
            <div className="mt-4 flex flex-wrap items-start gap-4">
              {actions.send ? (
                <ConfirmActionButton
                  action={sendRfqAction.bind(null, orgSlug, rfq.id)}
                  label={t("rfqs.send")}
                  variant="primary"
                  confirmMessage={t("rfqs.sendConfirm")}
                />
              ) : null}
              {actions.cancel ? (
                <div className="w-full max-w-md">
                  <ReasonForm
                    action={cancelRfqAction.bind(null, orgSlug, rfq.id)}
                    label={t("rfqs.cancelReason")}
                    submitLabel={t("rfqs.cancel")}
                    variant="danger"
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card title={t("rfqs.linesTitle")}>
          {lines.length === 0 ? (
            <EmptyState title={t("rfqs.noLines")} />
          ) : (
            <Table label={t("rfqs.linesTitle")}>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  {manage && actions.edit ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <Td className="tabular-nums">{l.lineNo}</Td>
                    <Td>
                      {productName(l.product, locale)}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {l.product.sku}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {qty(l.quantity)} {l.uom.code}
                      </span>
                    </Td>
                    {manage && actions.edit ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeRfqLineAction.bind(null, orgSlug, rfq.id, l.id)}
                          label={t("common.remove")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {manage && actions.edit && canCatalog ? (
            <div className="mt-4">
              <RequisitionLineForm
                action={addRfqLineAction.bind(null, orgSlug, rfq.id)}
                products={productOptions(productList, locale)}
                units={unitOptions(units, locale)}
              />
            </div>
          ) : null}
        </Card>

        <Card title={t("rfqs.suppliersTitle")}>
          <p className="text-muted mb-3 text-xs">{t("rfqs.suppliersHint")}</p>
          {suppliers.length === 0 ? (
            <EmptyState title={t("rfqs.noSuppliers")} />
          ) : (
            <ul className="divide-border divide-y text-sm">
              {suppliers.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <Link
                      href={`/o/${orgSlug}/suppliers/${s.id}`}
                      className="text-primary hover:underline"
                    >
                      {supplierName(s)}
                    </Link>{" "}
                    <span className="ltr-value text-muted font-mono text-xs">{s.code}</span>
                    {s.status !== "APPROVED" ? (
                      <span className="ms-2">
                        <Badge tone={s.status === "BLOCKED" ? "danger" : "warning"}>
                          {t(`suppliers.compliance.status.${s.status}`)}
                        </Badge>
                      </span>
                    ) : null}
                    {quoted.has(s.id) ? (
                      <span className="ms-2">
                        <Badge tone="success">{t("rfqs.quoted")}</Badge>
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-3">
                    <a
                      href={`${base}/pdf?supplierId=${s.id}`}
                      className="text-primary text-sm hover:underline"
                    >
                      {t("rfqs.pdf")}
                    </a>
                    {manage && actions.edit ? (
                      <ConfirmActionButton
                        action={removeRfqSupplierAction.bind(null, orgSlug, rfq.id, s.id)}
                        label={t("common.remove")}
                        variant="secondary"
                      />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {manage && actions.edit ? (
            <div className="mt-4">
              <InviteSupplierForm
                action={inviteRfqSupplierAction.bind(null, orgSlug, rfq.id)}
                suppliers={allSuppliers
                  .filter((s) => s.status !== "BLOCKED" && !suppliers.some((x) => x.id === s.id))
                  .map((s) => ({ value: s.id, label: `${s.code} — ${supplierName(s)}` }))}
              />
            </div>
          ) : null}
        </Card>

        {rfq.status !== "DRAFT" ? (
          <Card title={t("rfqs.comparisonTitle")}>
            <p className="text-muted mb-3 text-xs">
              {t("rfqs.comparisonHint", { currency: view.currency })}
            </p>
            {view.missingRates.length > 0 ? (
              <p role="status" className="text-warning mb-3 text-sm">
                {t("rfqs.missingRates", { currencies: view.missingRates.join(", ") })}
              </p>
            ) : null}
            {quotations.length === 0 ? (
              <EmptyState title={t("rfqs.noQuotations")} />
            ) : (
              <Table label={t("rfqs.comparisonTitle")}>
                <thead>
                  <tr>
                    <Th>{t("purchasing.product")}</Th>
                    {quotations.map((q) => (
                      <Th key={q.id}>
                        {supplierName(q.supplier)}
                        <span className="text-muted block text-xs font-normal">
                          {q.currency}
                          {q.expired ? ` · ${t("rfqs.expired")}` : ""}
                        </span>
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <Td>
                        {productName(l.product, locale)}
                        <span className="ltr-value text-muted block text-xs">
                          {qty(l.quantity)} {l.uom.code}
                        </span>
                      </Td>
                      {quotations.map((q) => {
                        const o = l.offers.find((x) => x.quotationId === q.id);
                        const awarded = l.awardedQuotationLineId === o?.quotationLineId && o;
                        return (
                          <Td
                            key={q.id}
                            className={`tabular-nums ${o?.lowest ? "bg-success-surface" : ""}`}
                          >
                            {o ? (
                              <>
                                <span className="ltr-value whitespace-nowrap">
                                  {moneyOf(q.currency).unitCost(o.unitPrice)} / {l.uom.code}
                                </span>
                                <span className="ltr-value text-muted block text-xs whitespace-nowrap">
                                  {o.comparable
                                    ? moneyOf(view.currency).money(o.comparable)
                                    : t("rfqs.noRate")}
                                </span>
                                {o.quantity ? (
                                  <span className="text-muted block text-xs">
                                    {t("rfqs.offersOnly", {
                                      quantity: `${qty(o.quantity)} ${l.uom.code}`,
                                    })}
                                  </span>
                                ) : null}
                                {o.lowest ? (
                                  <span className="text-success block text-xs">
                                    {t("rfqs.lowest")}
                                  </span>
                                ) : null}
                                {awarded ? (
                                  <span className="mt-1 block">
                                    <Badge tone="success">{t("rfqs.awarded")}</Badge>
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </Td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr>
                    <Td className="font-medium">{t("rfqs.total", { currency: view.currency })}</Td>
                    {quotations.map((q) => (
                      <Td key={q.id} className="font-medium tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {q.total ? moneyOf(view.currency).money(q.total) : t("rfqs.noRate")}
                        </span>
                        {!q.complete ? (
                          <span className="text-muted block text-xs font-normal">
                            {t("rfqs.incomplete")}
                          </span>
                        ) : null}
                      </Td>
                    ))}
                  </tr>
                </tbody>
              </Table>
            )}
          </Card>
        ) : null}

        {rfq.status !== "DRAFT" && quotations.length > 0 ? (
          <Card title={t("rfqs.quotationsTitle")}>
            <ul className="divide-border divide-y text-sm">
              {quotations.map((q) => (
                <li key={q.id} className="py-3">
                  <p className="font-medium">
                    {supplierName(q.supplier)}{" "}
                    {q.reference ? (
                      <span className="ltr-value text-muted font-mono text-xs">{q.reference}</span>
                    ) : null}
                  </p>
                  <p className="text-muted text-xs">
                    {t("rfqs.quotedOn")}: {date(q.quotedOn)} · {t("rfqs.validUntil")}:{" "}
                    {date(q.validUntil)}
                    {q.leadTimeDays !== null
                      ? ` · ${t("rfqs.leadTimeDays")}: ${q.leadTimeDays}`
                      : ""}
                  </p>
                  {q.note ? <p className="text-muted text-xs">{q.note}</p> : null}
                  <details className="mt-2">
                    <summary className="text-primary cursor-pointer text-sm">
                      {manage && actions.record ? t("rfqs.correctOrAttach") : t("rfqs.files")}
                    </summary>
                    <div className="mt-2 space-y-3">
                      <AttachmentsCard
                        ctx={ctx}
                        orgSlug={orgSlug}
                        entityType="QUOTATION"
                        entityId={q.id}
                      />
                      {manage && actions.record ? (
                        <QuotationForm
                          action={recordQuotationAction.bind(null, orgSlug, rfq.id)}
                          suppliers={[]}
                          currencies={currencies}
                          lines={quotable}
                          submitLabel={t("common.save")}
                          defaults={{
                            supplierId: q.supplier.id,
                            currency: q.currency,
                            reference: q.reference ?? undefined,
                            quotedOn: q.quotedOn.toISOString().slice(0, 10),
                            validUntil: q.validUntil?.toISOString().slice(0, 10),
                            leadTimeDays: q.leadTimeDays?.toString(),
                            note: q.note ?? undefined,
                            prices: Object.fromEntries(
                              q.lines.map((x) => [
                                x.rfqLineId,
                                {
                                  unitPrice: x.unitPrice.toString(),
                                  quantity: x.quantity?.toString(),
                                },
                              ]),
                            ),
                          }}
                        />
                      ) : null}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {manage && actions.record && suppliers.some((s) => !quoted.has(s.id)) ? (
          <Card title={t("rfqs.recordQuotation")}>
            <p className="text-muted mb-3 text-xs">{t("rfqs.recordHint")}</p>
            <QuotationForm
              action={recordQuotationAction.bind(null, orgSlug, rfq.id)}
              suppliers={suppliers
                .filter((s) => !quoted.has(s.id))
                .map((s) => ({ value: s.id, label: `${s.code} — ${supplierName(s)}` }))}
              currencies={currencies}
              lines={quotable}
              submitLabel={t("rfqs.recordQuotation")}
            />
          </Card>
        ) : null}

        {manage && actions.award && quotations.length > 0 ? (
          <Card title={t("rfqs.awardTitle")}>
            <p className="text-muted mb-3 text-xs">{t("rfqs.awardHint")}</p>
            <AwardForm
              action={awardRfqAction.bind(null, orgSlug, rfq.id)}
              lines={lines.map((l) => ({
                id: l.id,
                label: lineLabel(l),
                offers: l.offers.map((o) => {
                  const q = quotationOf(o.quotationId);
                  return {
                    quotationLineId: o.quotationLineId,
                    label: supplierName(q.supplier),
                    detail: `${moneyOf(q.currency).unitCost(o.unitPrice)} / ${l.uom.code}${
                      o.quantity ? ` · ${qty(o.quantity)} ${l.uom.code}` : ""
                    }`,
                    lowest: o.lowest,
                    expired: o.expired,
                    needsReason: o.needsReason,
                  };
                }),
              }))}
            />
          </Card>
        ) : null}

        {orders.length > 0 ? (
          <Card title={t("rfqs.ordersTitle")}>
            <ul className="divide-border divide-y text-sm">
              {orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2 py-2">
                  <Link
                    href={`/o/${orgSlug}/purchasing/orders/${o.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {o.number}
                  </Link>
                  <span className="flex items-center gap-3">
                    <span className="ltr-value tabular-nums">
                      {moneyOf(o.currency).money(o.totalAmount)}
                    </span>
                    <OrderStatusBadge status={o.status} />
                  </span>
                </li>
              ))}
            </ul>
            {lines.some((l) => l.awardReason) ? (
              <div className="mt-3 space-y-1 text-xs">
                {lines
                  .filter((l) => l.awardReason)
                  .map((l) => (
                    <p key={l.id}>
                      <span className="font-medium">{productName(l.product, locale)}:</span>{" "}
                      {l.awardReason}
                    </p>
                  ))}
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
