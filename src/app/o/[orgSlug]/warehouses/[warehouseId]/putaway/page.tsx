import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { PutAwayForm, PutawayRuleForm } from "@/components/wms/forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { listCategories } from "@/modules/catalog/categories";
import { listProductOptions } from "@/modules/catalog/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { putawayWorklist } from "@/modules/wms/putaway";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { categoryName, productName, quantityFormatter } from "@/server/inventory-view";
import { archiveRuleAction, createRuleAction, putAwayAction } from "./actions";

/** Directed put-away for one warehouse: stock waiting, suggestions and rules (ADR-101). */
export default async function PutawayPage({
  params,
}: PageProps<"/o/[orgSlug]/warehouses/[warehouseId]/putaway">) {
  const { orgSlug, warehouseId } = await params;
  if (!isUuid(warehouseId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const w = await notFoundOnAppError(putawayWorklist(ctx, warehouseId));
  const [t, locale, fmt, products, categories] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    w.canManage ? listProductOptions(ctx) : Promise.resolve([]),
    w.canManage ? listCategories(ctx) : Promise.resolve([]),
  ]);
  const place = (l: { code: string; name: string } | null) =>
    l ? `${l.code} — ${l.name}` : t("putaway.noLocation");
  const storageLocations = w.locations.filter(
    (l) => !l.archivedAt && (l.zone === "STORAGE" || l.zone === "PICKING"),
  );
  return (
    <>
      <PageHeader
        title={`${t("putaway.title")} — ${w.warehouse.code}`}
        description={
          <>
            {t("putaway.hint")}{" "}
            <Link
              href={`/o/${orgSlug}/warehouses/${w.warehouse.id}`}
              className="text-primary hover:underline"
            >
              {w.warehouse.name}
            </Link>
          </>
        }
      />
      <div className="space-y-6">
        <h2 className="text-lg font-semibold">{t("putaway.waiting")}</h2>
        {w.items.length === 0 ? (
          <EmptyState title={t("putaway.nothingWaiting")} />
        ) : (
          <Table label={t("putaway.waiting")}>
            <thead>
              <tr>
                <Th>{t("putaway.product")}</Th>
                <Th>{t("putaway.from")}</Th>
                <Th>{t("putaway.onHand")}</Th>
                <Th>{t("putaway.suggestion")}</Th>
                <Th>{t("putaway.action")}</Th>
              </tr>
            </thead>
            <tbody>
              {w.items.map((i) => {
                const unit = i.product.baseUom.code;
                const suggested =
                  i.suggestion.source === "NONE" ? undefined : i.suggestion.locationId;
                const suggestedPlace = suggested
                  ? w.locations.find((l) => l.id === suggested)
                  : null;
                return (
                  <tr key={i.id}>
                    <Td>
                      {i.product.sku} — {productName(i.product, locale)}
                      <span className="text-muted block text-xs">
                        {i.lot ? `${i.lot.lotCode} · ` : ""}
                        {t(`catalog.zones.${i.product.storageRequirement}`)}
                      </span>
                    </Td>
                    <Td>{place(i.location)}</Td>
                    <Td className="ltr-value tabular-nums">{`${fmt(i.onHandQuantity)} ${unit}`}</Td>
                    <Td>
                      {suggestedPlace ? place(suggestedPlace) : "—"}
                      <span className="text-muted block text-xs">
                        {t(`putaway.sources.${i.suggestion.source}`)}
                      </span>
                    </Td>
                    <Td>
                      {!w.canPutAway ? null : i.targets.length === 0 ? (
                        <span className="text-muted text-sm">{t("putaway.noTargets")}</span>
                      ) : (
                        <PutAwayForm
                          action={putAwayAction.bind(null, orgSlug, i.id)}
                          targets={i.targets.map((l) => ({ value: l.id, label: place(l) }))}
                          suggested={suggested}
                          quantity={i.onHandQuantity.toString()}
                          unit={unit}
                        />
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        <Card title={t("putaway.rules")}>
          <p className="text-muted mb-4 text-sm">{t("putaway.rulesHint")}</p>
          {w.rules.length === 0 ? (
            <EmptyState title={t("putaway.noRules")} />
          ) : (
            <Table label={t("putaway.rules")}>
              <thead>
                <tr>
                  <Th>{t("putaway.priority")}</Th>
                  <Th>{t("putaway.matches")}</Th>
                  <Th>{t("putaway.location")}</Th>
                  {w.canManage ? <Th /> : null}
                </tr>
              </thead>
              <tbody>
                {w.rules.map((r) => (
                  <tr key={r.id}>
                    <Td className="ltr-value tabular-nums">{r.priority}</Td>
                    <Td>
                      {[
                        r.product ? `${r.product.sku} — ${productName(r.product, locale)}` : null,
                        r.category ? categoryName(r.category, locale) : null,
                        r.storageRequirement ? t(`catalog.zones.${r.storageRequirement}`) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || t("putaway.any")}
                    </Td>
                    <Td>{`${r.location.code}`}</Td>
                    {w.canManage ? (
                      <Td>
                        <ConfirmActionButton
                          action={archiveRuleAction.bind(null, orgSlug, r.id)}
                          label={t("common.archive")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {w.canManage ? (
            <div className="border-border mt-4 border-t pt-4">
              {storageLocations.length === 0 ? (
                <p className="text-muted text-sm">{t("putaway.noStorage")}</p>
              ) : (
                <PutawayRuleForm
                  action={createRuleAction.bind(null, orgSlug, w.warehouse.id)}
                  locations={storageLocations.map((l) => ({
                    value: l.id,
                    label: `${place(l)} · ${t(`warehouses.zones.${l.temperatureZone}`)}`,
                  }))}
                  products={products.map((p) => ({
                    value: p.id,
                    label: `${p.sku} — ${productName(p, locale)}`,
                  }))}
                  categories={categories.map((c) => ({
                    value: c.id,
                    label: categoryName(c, locale),
                  }))}
                />
              )}
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
