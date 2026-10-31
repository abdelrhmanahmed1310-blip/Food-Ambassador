import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { TextReasonForm } from "@/components/invoices/forms";
import { ProductionStatusBadge } from "@/components/production/badges";
import { CompleteProductionForm } from "@/components/production/forms";
import {
  Alert,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getProductionOrder } from "@/modules/production/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";
import {
  cancelProductionAction,
  completeProductionAction,
  reverseProductionAction,
} from "../actions";

export default async function ProductionOrderPage({
  params,
}: PageProps<"/o/[orgSlug]/production/[orderId]">) {
  const { orgSlug, orderId } = await params;
  if (!isUuid(orderId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const o = await notFoundOnAppError(getProductionOrder(ctx, orderId));
  const [t, locale, format, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const short = o.needed.some((n) => n.available.lt(n.quantity));
  return (
    <>
      <PageHeader
        title={o.number}
        description={`${o.recipe.code} — ${(locale === "ar" && o.recipe.nameAr) || o.recipe.name}`}
        actions={<ProductionStatusBadge status={o.status} />}
      />
      <div className="space-y-6">
        {o.closeReason ? (
          <Alert tone="info">{t("production.closedBecause", { reason: o.closeReason })}</Alert>
        ) : null}
        <Card>
          <DescriptionList
            items={[
              {
                label: t("production.warehouse"),
                value: `${o.warehouse.code} — ${o.warehouse.name}`,
              },
              {
                label: t("production.planned"),
                value: (
                  <span className="ltr-value">
                    {fmt(o.plannedQuantity)} {o.plannedUom.code}
                  </span>
                ),
              },
              {
                label: t("production.outputProduct"),
                value: `${o.outputProduct.sku} — ${productName(o.outputProduct, locale)}`,
              },
              {
                label: t("production.plannedFor"),
                value: o.plannedFor?.toISOString().slice(0, 10) ?? "—",
              },
              ...(o.producedQuantityBase
                ? [
                    {
                      label: t("production.produced"),
                      value: (
                        <span className="ltr-value" data-testid="produced">
                          {fmt(o.producedQuantityBase)} {o.outputProduct.baseUom.code}
                        </span>
                      ),
                    },
                    {
                      label: t("production.cost"),
                      value: (
                        <span className="ltr-value" data-testid="production-cost">
                          {money.money(o.cost!)}
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(o.outputLot
                ? [
                    {
                      label: t("production.lotCode"),
                      value: (
                        <Link
                          href={`/o/${orgSlug}/traceability/lots/${o.outputLot.id}`}
                          className="ltr-value text-primary font-mono hover:underline"
                        >
                          {o.outputLot.lotCode}
                          {o.outputLot.expiresOn
                            ? ` · ${o.outputLot.expiresOn.toISOString().slice(0, 10)}`
                            : ""}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...(o.document
                ? [
                    {
                      label: t("production.document"),
                      value: (
                        <Link
                          href={`/o/${orgSlug}/inventory/documents/${o.document.id}`}
                          className="ltr-value text-primary font-mono hover:underline"
                        >
                          {o.document.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              { label: t("purchasing.createdBy"), value: dt(o.createdAt) },
              ...(o.completedAt
                ? [{ label: t("production.completedAt"), value: dt(o.completedAt) }]
                : []),
              { label: t("common.note"), value: o.note ?? "—" },
            ]}
          />
        </Card>

        {o.status === "PLANNED" ? (
          <Card title={t("production.ingredientsNeeded")}>
            {o.problems.length > 0 ? (
              <Alert tone="error">{t("production.notExpandable")}</Alert>
            ) : null}
            <Table label={t("production.ingredientsNeeded")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("production.needed")}</Th>
                  <Th>{t("production.usable")}</Th>
                </tr>
              </thead>
              <tbody>
                {o.needed.map((n) => (
                  <tr key={n.product.id} data-testid={`needed-${n.product.sku}`}>
                    <Td>
                      {productName(n.product, locale)}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {n.product.sku}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">
                        {fmt(n.quantity)} {n.product.baseUom.code}
                      </span>
                    </Td>
                    <Td
                      className={`tabular-nums ${n.available.lt(n.quantity) ? "text-danger font-medium" : ""}`}
                    >
                      <span className="ltr-value">
                        {fmt(n.available)} {n.product.baseUom.code}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {short ? <p className="text-danger mt-3 text-sm">{t("production.short")}</p> : null}
          </Card>
        ) : null}

        {o.used.length > 0 ? (
          <Card title={t("production.ingredientsUsed")}>
            <Table label={t("production.ingredientsUsed")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("production.lot")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  <Th>{t("production.value")}</Th>
                </tr>
              </thead>
              <tbody>
                {o.used.map((u, i) => (
                  <tr key={i}>
                    <Td>
                      {u.product.sku} — {productName(u.product, locale)}
                    </Td>
                    <Td>
                      {u.lot ? (
                        <Link
                          href={`/o/${orgSlug}/traceability/lots/${u.lot.id}`}
                          className="ltr-value text-primary font-mono text-xs hover:underline"
                        >
                          {u.lot.lotCode}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">
                        {fmt(u.quantity)} {u.product.baseUom.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">{money.money(u.value)}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : null}

        {o.can.complete ? (
          <Card title={t("production.complete")}>
            <p className="text-muted mb-3 text-sm">{t("production.completeHint")}</p>
            <CompleteProductionForm
              action={completeProductionAction.bind(null, orgSlug, o.id)}
              unit={o.plannedUom.code}
              plannedQuantity={o.plannedQuantity.toFixed()}
              lotTracked={o.outputProduct.lotTracking !== "NONE"}
              defaultLot={o.number}
            />
          </Card>
        ) : null}
        {o.can.cancel ? (
          <Card title={t("production.cancel")}>
            <TextReasonForm
              action={cancelProductionAction.bind(null, orgSlug, o.id)}
              name="reason"
              label={t("invoices.cancelReason")}
              submitLabel={t("production.cancel")}
              variant="danger"
            />
          </Card>
        ) : null}
        {o.can.reverse ? (
          <Card title={t("production.reverse")}>
            <p className="text-muted mb-3 text-sm">{t("production.reverseHint")}</p>
            <TextReasonForm
              action={reverseProductionAction.bind(null, orgSlug, o.id)}
              name="reason"
              label={t("invoices.cancelReason")}
              submitLabel={t("production.reverse")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
