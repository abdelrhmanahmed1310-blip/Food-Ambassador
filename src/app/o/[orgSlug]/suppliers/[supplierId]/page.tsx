import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { SupplierForm, SupplierProductForm } from "@/components/procurement/forms";
import {
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { getSupplier } from "@/modules/procurement/suppliers";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  moneyFormatter,
  productName,
  productOptions,
  quantityFormatter,
  unitOptions,
} from "@/server/inventory-view";
import {
  removeSupplierProductAction,
  saveSupplierProductAction,
  setSupplierArchivedAction,
  updateSupplierAction,
} from "../actions";

export default async function SupplierPage({
  params,
}: PageProps<"/o/[orgSlug]/suppliers/[supplierId]">) {
  const { orgSlug, supplierId } = await params;
  if (!isUuid(supplierId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const { supplier, products, performance } = await notFoundOnAppError(
    getSupplier(ctx, supplierId),
  );
  const canManage = hasPermission(ctx.grants, "suppliers.manage");
  const [t, locale, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const [productList, units] = canManage
    ? await Promise.all([listProductOptions(ctx), listUnits(ctx)])
    : [[], []];
  const archived = supplier.archivedAt !== null;
  const percent = (v: Decimal | null) =>
    v === null ? t("suppliers.notMeasured") : `${fmt(v.times(100).toDecimalPlaces(1))} %`;
  const name = (locale === "ar" && supplier.nameAr) || supplier.name;

  return (
    <>
      <PageHeader
        title={name}
        description={supplier.code}
        actions={
          <>
            {archived ? <Badge tone="muted">{t("common.archived")}</Badge> : null}
            {holdsAnyGrant(ctx.grants, "purchasing.view") ? (
              <LinkButton
                href={`/o/${orgSlug}/purchasing/orders?supplierId=${supplier.id}`}
                variant="secondary"
              >
                {t("suppliers.viewOrders")}
              </LinkButton>
            ) : null}
            {!archived && holdsAnyGrant(ctx.grants, "purchasing.manage") ? (
              <LinkButton href={`/o/${orgSlug}/purchasing/orders/new?supplierId=${supplier.id}`}>
                {t("suppliers.newOrder")}
              </LinkButton>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card title={t("suppliers.performanceTitle")}>
          <p className="text-muted mb-3 text-xs">{t("suppliers.performanceHint")}</p>
          <DescriptionList
            items={[
              { label: t("suppliers.receiptsCount"), value: performance.receipts },
              { label: t("suppliers.onTime"), value: percent(performance.onTimeRate) },
              { label: t("suppliers.fillRate"), value: percent(performance.fillRate) },
              { label: t("suppliers.rejectionRate"), value: percent(performance.rejectionRate) },
              {
                label: t("suppliers.priceVariance"),
                value:
                  performance.receipts === 0 ? (
                    t("suppliers.notMeasured")
                  ) : (
                    <span
                      title={t("suppliers.priceVarianceHint")}
                      className="ltr-value tabular-nums"
                    >
                      {money.money(performance.priceVariance)}
                    </span>
                  ),
              },
            ]}
          />
        </Card>

        <Card title={t("suppliers.productsTitle")}>
          {products.length === 0 ? (
            <EmptyState title={t("suppliers.noProducts")} />
          ) : (
            <Table label={t("suppliers.productsTitle")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("suppliers.purchaseUnit")}</Th>
                  <Th>{t("suppliers.supplierSku")}</Th>
                  <Th>{t("suppliers.lastPrice")}</Th>
                  <Th>{t("suppliers.leadTimeDays")}</Th>
                  {canManage ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      {productName(p.product, locale)}
                      {p.preferred ? (
                        <span className="ms-2">
                          <Badge tone="success">{t("suppliers.preferred")}</Badge>
                        </span>
                      ) : null}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {p.product.sku}
                      </span>
                    </Td>
                    <Td>
                      <span className="ltr-value">{p.purchaseUom.code}</span>
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{p.supplierSku ?? "—"}</span>
                    </Td>
                    <Td className="tabular-nums">
                      {p.lastUnitPrice ? (
                        <span className="ltr-value">
                          {money.unitCost(p.lastUnitPrice)} / {p.purchaseUom.code}
                        </span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td className="tabular-nums">
                      {p.leadTimeDays ?? supplier.leadTimeDays ?? "—"}
                    </Td>
                    {canManage ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeSupplierProductAction.bind(
                            null,
                            orgSlug,
                            supplier.id,
                            p.id,
                          )}
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
          {canManage ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold">{t("suppliers.addProduct")}</h3>
              <SupplierProductForm
                action={saveSupplierProductAction.bind(null, orgSlug, supplier.id)}
                products={productOptions(productList, locale)}
                units={unitOptions(units, locale)}
                currency={ctx.baseCurrency}
              />
            </div>
          ) : null}
        </Card>

        {canManage ? (
          <Card title={t("suppliers.editTitle")}>
            <SupplierForm
              action={updateSupplierAction.bind(null, orgSlug, supplier.id)}
              submitLabel={t("common.save")}
              defaults={{
                code: supplier.code,
                name: supplier.name,
                nameAr: supplier.nameAr ?? undefined,
                taxId: supplier.taxId ?? undefined,
                contactName: supplier.contactName ?? undefined,
                email: supplier.email ?? undefined,
                phone: supplier.phone ?? undefined,
                address: supplier.address ?? undefined,
                paymentTermsDays: supplier.paymentTermsDays?.toString(),
                leadTimeDays: supplier.leadTimeDays?.toString(),
                note: supplier.note ?? undefined,
              }}
            />
          </Card>
        ) : (
          <Card>
            <DescriptionList
              items={[
                { label: t("suppliers.contactName"), value: supplier.contactName ?? "—" },
                { label: t("suppliers.email"), value: supplier.email ?? "—" },
                { label: t("suppliers.phone"), value: supplier.phone ?? "—" },
                { label: t("suppliers.paymentTermsDays"), value: supplier.paymentTermsDays ?? "—" },
              ]}
            />
          </Card>
        )}
        {canManage ? (
          <Card>
            <p className="text-muted mb-3 text-sm">{t("suppliers.archiveHint")}</p>
            <ConfirmActionButton
              action={setSupplierArchivedAction.bind(null, orgSlug, supplier.id, !archived)}
              label={archived ? t("common.restore") : t("common.archive")}
              variant={archived ? "secondary" : "danger"}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
