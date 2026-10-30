import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { BarcodeForm, ConversionForm, ProductForm } from "@/components/inventory/forms";
import {
  Badge,
  Card,
  DescriptionList,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { listCategories } from "@/modules/catalog/categories";
import { getProduct, listUnits } from "@/modules/catalog/service";
import { productStockSummary } from "@/modules/inventory/queries";
import { businessDate } from "@/modules/inventory/rules";
import { listStandardCosts } from "@/modules/recipes/costs";
import { StandardCostForm } from "@/components/recipes/forms";
import { addStandardCostAction } from "../../../recipes/actions";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  categoryName,
  categoryOptions,
  moneyFormatter,
  productName,
  quantityFormatter,
  unitOptions,
} from "@/server/inventory-view";
import {
  addBarcodeAction,
  addConversionAction,
  removeBarcodeAction,
  removeConversionAction,
  setProductArchivedAction,
  updateProductAction,
} from "../../actions";

export default async function ProductPage({
  params,
}: PageProps<"/o/[orgSlug]/catalog/products/[productId]">) {
  const { orgSlug, productId } = await params;
  if (!isUuid(productId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const product = await notFoundOnAppError(getProduct(ctx, productId));
  const [t, locale, units, fmt, categories] = await Promise.all([
    getTranslations(),
    getLocale(),
    listUnits(ctx),
    quantityFormatter(),
    listCategories(ctx),
  ]);
  const stock = hasPermission(ctx.grants, "inventory.view")
    ? await productStockSummary(ctx, productId)
    : null;
  const canManage = hasPermission(ctx.grants, "catalog.manage");
  const costsVisible = hasPermission(ctx.grants, "recipes.costs.view");
  const [standardCosts, money] = costsVisible
    ? await Promise.all([listStandardCosts(ctx, productId), moneyFormatter(ctx.baseCurrency)])
    : [[], null];
  const canSetCost = costsVisible && hasPermission(ctx.grants, "recipes.manage");
  const otherUnits = units.filter((u) => u.id !== product.baseUomId);

  return (
    <>
      <PageHeader
        title={productName(product, locale)}
        description={product.sku}
        actions={
          <>
            {product.archivedAt ? <Badge tone="muted">{t("common.archived")}</Badge> : null}
            {hasPermission(ctx.grants, "nutrition.view") ? (
              <LinkButton
                href={`/o/${orgSlug}/catalog/products/${productId}/nutrition`}
                variant="secondary"
              >
                {t("nutrition.nutritionAndAllergens")}
              </LinkButton>
            ) : null}
            {stock ? (
              <LinkButton
                href={`/o/${orgSlug}/inventory/stock?productId=${productId}`}
                variant="secondary"
              >
                {t("catalog.viewStock")}
              </LinkButton>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        {canManage ? (
          <Card title={t("catalog.editProduct")}>
            <ProductForm
              action={updateProductAction.bind(null, orgSlug, productId)}
              units={unitOptions(units, locale)}
              categories={categoryOptions(
                // Keep the current category selectable even if it was archived since.
                product.category && !categories.some((c) => c.id === product.category!.id)
                  ? [...categories, product.category]
                  : categories,
                locale,
              )}
              submitLabel={t("common.save")}
              locked={product.hasHistory}
              defaults={{
                sku: product.sku,
                nameEn: product.nameEn,
                nameAr: product.nameAr ?? "",
                type: product.type,
                baseUomId: product.baseUomId,
                lotTracking: product.lotTracking,
                shelfLifeDays: product.shelfLifeDays?.toString() ?? "",
                storageRequirement: product.storageRequirement,
                categoryId: product.categoryId ?? "",
              }}
            />
          </Card>
        ) : (
          <Card>
            <DescriptionList
              items={[
                { label: t("catalog.type"), value: t(`catalog.types.${product.type}`) },
                {
                  label: t("catalog.category"),
                  value: product.category ? categoryName(product.category, locale) : "—",
                },
                { label: t("catalog.baseUnit"), value: product.baseUom.code },
                {
                  label: t("catalog.lotTracking"),
                  value: t(`catalog.lotModes.${product.lotTracking}`),
                },
                {
                  label: t("catalog.storage"),
                  value: t(`catalog.zones.${product.storageRequirement}`),
                },
              ]}
            />
          </Card>
        )}

        {stock ? (
          <Card title={t("catalog.stockSummary")}>
            {stock.length === 0 ? (
              <p className="text-muted text-sm">{t("catalog.noStock")}</p>
            ) : (
              <Table label={t("catalog.stockSummary")}>
                <thead>
                  <tr>
                    <Th>{t("common.warehouse")}</Th>
                    <Th>{t("inventory.status")}</Th>
                    <Th>{t("inventory.onHand")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {stock.map((s) => (
                    <tr key={`${s.warehouse.id}-${s.stockStatus}`}>
                      <Td>
                        <Link
                          className="text-primary hover:underline"
                          href={`/o/${orgSlug}/inventory/stock?productId=${productId}&warehouseId=${s.warehouse.id}`}
                        >
                          {s.warehouse.code} — {s.warehouse.name}
                        </Link>
                      </Td>
                      <Td>{t(`inventory.statuses.${s.stockStatus}`)}</Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value">
                          {fmt(s.onHand)} {product.baseUom.code}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ) : null}

        {costsVisible && money ? (
          <Card title={t("recipes.standardCosts")}>
            <p className="text-muted mb-3 text-sm">{t("recipes.standardCostHint")}</p>
            {standardCosts.length === 0 ? (
              <p className="text-muted mb-4 text-sm">{t("recipes.noStandardCosts")}</p>
            ) : (
              <Table label={t("recipes.standardCosts")}>
                <thead>
                  <tr>
                    <Th>{t("recipes.effectiveFrom")}</Th>
                    <Th>{t("recipes.standardCost")}</Th>
                    <Th>{t("common.note")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {standardCosts.map((c) => (
                    <tr key={c.id}>
                      <Td className="whitespace-nowrap">
                        {c.effectiveFrom.toISOString().slice(0, 10)}
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {money.unitCost(c.unitCost)} / {product.baseUom.code}
                        </span>
                      </Td>
                      <Td>{c.note ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {canSetCost ? (
              <div className="mt-4">
                <StandardCostForm
                  action={addStandardCostAction.bind(null, orgSlug, product.id)}
                  currency={ctx.baseCurrency}
                  baseUnit={product.baseUom.code}
                  today={businessDate(ctx.timeZone)}
                />
              </div>
            ) : null}
          </Card>
        ) : null}

        <Card title={t("catalog.barcodes")}>
          {product.barcodes.length === 0 ? (
            <p className="text-muted mb-4 text-sm">{t("catalog.noBarcodes")}</p>
          ) : null}
          <ul className="divide-border mb-4 divide-y">
            {product.barcodes.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm">
                  <span className="ltr-value font-mono">{b.barcode}</span> ·{" "}
                  {t(`catalog.symbologies.${b.symbology}`)}
                  {b.uom ? ` · ${b.uom.code}` : ""}
                </span>
                {canManage ? (
                  <ConfirmActionButton
                    action={removeBarcodeAction.bind(null, orgSlug, productId, b.id)}
                    label={t("common.remove")}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {canManage ? (
            <BarcodeForm
              action={addBarcodeAction.bind(null, orgSlug, productId)}
              packUnits={unitOptions(otherUnits, locale)}
            />
          ) : null}
        </Card>

        <Card title={t("catalog.conversions")}>
          <p className="text-muted mb-3 text-sm">{t("catalog.conversionsHint")}</p>
          {product.conversions.length === 0 ? (
            <p className="text-muted mb-4 text-sm">{t("catalog.noConversions")}</p>
          ) : null}
          <ul className="divide-border mb-4 divide-y">
            {product.conversions.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="ltr-value text-sm">
                  {t("catalog.conversionText", {
                    unit: c.uom.code,
                    factor: fmt(c.factorToBase),
                    base: product.baseUom.code,
                  })}
                </span>
                {canManage ? (
                  <ConfirmActionButton
                    action={removeConversionAction.bind(null, orgSlug, productId, c.id)}
                    label={t("common.remove")}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {canManage ? (
            <ConversionForm
              action={addConversionAction.bind(null, orgSlug, productId)}
              units={unitOptions(otherUnits, locale)}
              baseUnit={product.baseUom.code}
            />
          ) : null}
        </Card>

        {canManage ? (
          <Card>
            {product.archivedAt ? (
              <ConfirmActionButton
                action={setProductArchivedAction.bind(null, orgSlug, productId, false)}
                label={t("common.restore")}
                variant="secondary"
              />
            ) : (
              <ConfirmActionButton
                action={setProductArchivedAction.bind(null, orgSlug, productId, true)}
                label={t("common.archive")}
                confirmMessage={t("common.confirm")}
              />
            )}
          </Card>
        ) : null}
        <p className="text-muted text-xs">
          <Link href={`/o/${orgSlug}/catalog/products`} className="hover:underline">
            {t("common.back")}
          </Link>
        </p>
      </div>
    </>
  );
}
