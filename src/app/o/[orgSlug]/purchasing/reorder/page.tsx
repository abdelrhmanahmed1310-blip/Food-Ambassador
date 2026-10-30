import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CreateOrdersForm, ReorderRuleForm } from "@/components/procurement/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { reorderPlan } from "@/modules/procurement/reorder";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  moneyFormatter,
  productName,
  productOptions,
  quantityFormatter,
  unitOptions,
} from "@/server/inventory-view";
import {
  createOrdersFromPlanAction,
  removeReorderRuleAction,
  saveReorderRuleAction,
} from "../actions";

const FORM_ID = "create-orders";

export default async function ReorderPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/reorder">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.view")) notFound();
  const [t, locale, fmt, money, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
    purchasingWarehouseOptions(ctx, "purchasing.view"),
  ]);
  const requested =
    typeof sp.warehouseId === "string" && isUuid(sp.warehouseId) ? sp.warehouseId : undefined;
  const warehouseId = warehouses.find((w) => w.id === requested)?.id ?? warehouses[0]?.id;
  const plan = warehouseId ? await reorderPlan(ctx, warehouseId) : null;
  const [products, units] = plan?.canManage
    ? await Promise.all([listProductOptions(ctx), listUnits(ctx)])
    : [[], []];

  return (
    <>
      <PageHeader title={t("reorder.title")} description={t("reorder.hint")} />
      {warehouses.length === 0 || !plan ? (
        <EmptyState title={t("warehouses.empty")} />
      ) : (
        <div className="space-y-6">
          <form method="get" className="flex gap-2">
            <label htmlFor="warehouseId" className="sr-only">
              {t("common.warehouse")}
            </label>
            <select
              id="warehouseId"
              name="warehouseId"
              defaultValue={plan.warehouse.id}
              className={`${inputClass} sm:w-72`}
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
            <button type="submit" className={buttonClass("secondary")}>
              {t("common.apply")}
            </button>
          </form>
          {plan.lines.length === 0 ? (
            <EmptyState title={t("reorder.noRules")} hint={t("reorder.noRulesHint")} />
          ) : (
            <Table label={t("reorder.title")}>
              <thead>
                <tr>
                  {plan.canManage ? <Th>{t("reorder.select")}</Th> : null}
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("reorder.available")}</Th>
                  <Th>{t("reorder.onOrder")}</Th>
                  <Th>{t("reorder.minMax")}</Th>
                  <Th>{t("reorder.suggested")}</Th>
                  <Th>{t("purchasing.supplier")}</Th>
                  {plan.canManage ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((l) => {
                  const unit = l.rule.product.baseUom.code;
                  const orderable = l.suggestion && l.reason === "OK";
                  return (
                    <tr key={l.rule.id}>
                      {plan.canManage ? (
                        <Td>
                          {orderable ? (
                            <input
                              type="checkbox"
                              name="ruleId"
                              value={l.rule.id}
                              form={FORM_ID}
                              defaultChecked
                              aria-label={l.rule.product.sku}
                            />
                          ) : null}
                        </Td>
                      ) : null}
                      <Td>
                        {productName(l.rule.product, locale)}
                        <span className="ltr-value text-muted block font-mono text-xs">
                          {l.rule.product.sku}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {fmt(l.availableBase)} {unit}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {fmt(l.onOrderBase)} {unit}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {fmt(l.rule.minQuantityBase)} – {fmt(l.rule.maxQuantityBase)} {unit}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        {l.suggestion ? (
                          <>
                            <span className="ltr-value font-medium whitespace-nowrap">
                              {fmt(l.suggestion.purchaseUnits)} {l.source?.purchaseUom.code ?? unit}
                            </span>
                            {l.reason !== "OK" ? (
                              <span className="mt-1 block">
                                <Badge tone="warning">{t(`reorder.reasons.${l.reason}`)}</Badge>
                              </span>
                            ) : l.source?.lastUnitPrice ? (
                              <span className="ltr-value text-muted block text-xs">
                                ≈{" "}
                                {money.money(
                                  l.suggestion.purchaseUnits.times(
                                    l.source.lastUnitPrice.toString(),
                                  ),
                                )}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-muted">{t("reorder.enough")}</span>
                        )}
                      </Td>
                      <Td>
                        {l.source
                          ? (locale === "ar" && l.source.supplier.nameAr) || l.source.supplier.name
                          : "—"}
                      </Td>
                      {plan.canManage ? (
                        <Td>
                          <ConfirmActionButton
                            action={removeReorderRuleAction.bind(null, orgSlug, l.rule.id)}
                            label={t("common.remove")}
                            variant="secondary"
                          />
                        </Td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {/* Kept after ordering so its result message stays visible. */}
          {plan.canManage && plan.lines.length > 0 ? (
            <Card>
              <CreateOrdersForm
                formId={FORM_ID}
                action={createOrdersFromPlanAction.bind(null, orgSlug, plan.warehouse.id)}
              />
            </Card>
          ) : null}
          {plan.canManage ? (
            <Card title={t("reorder.addRule")}>
              <ReorderRuleForm
                action={saveReorderRuleAction.bind(null, orgSlug, plan.warehouse.id)}
                products={productOptions(products, locale)}
                units={unitOptions(units, locale)}
              />
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
