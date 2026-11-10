import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { PhotoForm } from "@/components/media/photo-form";
import {
  AttachGroupForm,
  ComboComponentForm,
  MenuItemForm,
  MenuPriceForm,
} from "@/components/menu/forms";
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
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import { SALES_CHANNELS } from "@/modules/menu/rules";
import { imageUrl } from "@/modules/media/images";
import { getMenuItem, menuFormOptions } from "@/modules/menu/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, moneyFormatters } from "@/server/inventory-view";
import {
  addComboComponentAction,
  addMenuItemPriceAction,
  attachModifierGroupAction,
  detachModifierGroupAction,
  removeComboComponentAction,
  setItemAvailabilityAction,
  setMenuItemArchivedAction,
  removeMenuItemPhotoAction,
  setMenuItemPhotoAction,
  updateMenuItemAction,
} from "../../actions";

const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function MenuItemPage({
  params,
}: PageProps<"/o/[orgSlug]/menu/items/[itemId]">) {
  const { orgSlug, itemId } = await params;
  if (!isUuid(itemId)) notFound();
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "menu.view")) notFound();
  const item = await notFoundOnAppError(getMenuItem(ctx, itemId));
  const manage = hasPermission(ctx.grants, "menu.manage");
  const [t, locale, money, o] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.groupCurrency),
    manage ? menuFormOptions(ctx) : Promise.resolve(null),
  ]);
  // A price for all branches is in the group's currency; a branch's in its company's (ADR-086).
  const moneyIn = await moneyFormatters();
  const off = new Set(item.unavailable.map((u) => u.branchId));
  const delta = (v: { toString(): string }) => {
    const n = v.toString();
    return n.startsWith("-") ? money.money(v) : `+${money.money(v)}`;
  };
  return (
    <>
      <PageHeader
        title={`${item.code} — ${(locale === "ar" && item.nameAr) || item.name}`}
        description={t(`menu.kinds.${item.kind}`)}
        actions={
          <>
            <LinkButton href={`/o/${orgSlug}/menu`} variant="secondary">
              {t("menu.title")}
            </LinkButton>
            {manage ? (
              <ConfirmActionButton
                action={setMenuItemArchivedAction.bind(null, orgSlug, item.id, !item.archivedAt)}
                label={t(item.archivedAt ? "menu.restore" : "menu.archive")}
                variant={item.archivedAt ? "secondary" : "danger"}
              />
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card title={t("photos.title")}>
          <p className="text-muted mb-3 text-sm">{t("photos.itemHint")}</p>
          {manage ? (
            <PhotoForm
              imageUrl={imageUrl(item.imageId ?? item.product?.imageId)}
              inherited={!item.imageId && !!item.product?.imageId}
              alt={item.name}
              upload={setMenuItemPhotoAction.bind(null, orgSlug, item.id)}
              remove={removeMenuItemPhotoAction.bind(null, orgSlug, item.id)}
            />
          ) : (item.imageId ?? item.product?.imageId) ? (
            // eslint-disable-next-line @next/next/no-img-element -- served from /media with long-lived caching
            <img
              src={imageUrl(item.imageId ?? item.product?.imageId)!}
              alt={item.name}
              className="size-40 rounded-xl object-cover"
            />
          ) : (
            <p className="text-muted text-sm">{t("photos.none")}</p>
          )}
        </Card>
        <Card>
          <DescriptionList
            items={[
              {
                label: t("menu.category"),
                value: <bdi>{(locale === "ar" && item.category.nameAr) || item.category.name}</bdi>,
              },
              {
                label: t("menu.uses"),
                value: item.recipe
                  ? `${t("menu.usesRecipe")}: ${item.recipe.code} — ${item.recipe.name}`
                  : item.product
                    ? `${t("menu.usesProduct")}: ${item.product.sku} — ${item.product.nameEn} × ${item.productQuantity?.toFixed()} ${item.product.baseUom.code}`
                    : t("menu.comboHint"),
              },
              { label: t("menu.taxCode"), value: item.taxCode?.code ?? t("menu.taxDefault") },
              {
                label: t("menu.barcodes"),
                value:
                  [item.barcode, ...(item.product?.barcodes.map((b) => b.barcode) ?? [])]
                    .filter(Boolean)
                    .join(", ") || "—",
              },
              ...(item.archivedAt
                ? [
                    {
                      label: t("menu.status"),
                      value: <Badge tone="muted">{t("menu.archived")}</Badge>,
                    },
                  ]
                : []),
            ]}
          />
        </Card>

        <Card title={t("menu.prices")}>
          {item.prices.length === 0 ? (
            <p className="text-muted mb-4 text-sm">{t("menu.noPrices")}</p>
          ) : (
            <div className="mb-4">
              <Table label={t("menu.prices")}>
                <thead>
                  <tr>
                    <Th>{t("menu.channel")}</Th>
                    <Th>{t("menu.branch")}</Th>
                    <Th>{t("menu.price")}</Th>
                    <Th>{t("menu.effectiveFrom")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {item.prices.map((p) => (
                    <tr key={p.id}>
                      <Td>{t(`menu.channels.${p.channel}`)}</Td>
                      <Td>
                        {p.branch ? `${p.branch.code} — ${p.branch.name}` : t("menu.allBranches")}
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value">
                          {moneyIn(p.branch?.company.currency ?? ctx.groupCurrency).money(p.price)}
                        </span>{" "}
                        <span className="text-muted text-xs">
                          {t(p.includesTax ? "menu.inclVat" : "menu.exclVat")}
                        </span>
                      </Td>
                      <Td>
                        <span className="ltr-value">{day(p.effectiveFrom)}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          {o ? (
            <MenuPriceForm
              action={addMenuItemPriceAction.bind(null, orgSlug, item.id)}
              channels={SALES_CHANNELS.map((c) => ({ value: c, label: t(`menu.channels.${c}`) }))}
              branches={o.branches.map((b) => ({
                value: b.id,
                label: `${b.code} — ${b.name}${b.company.currency === ctx.groupCurrency ? "" : ` (${b.company.currency})`}`,
              }))}
              currency={ctx.groupCurrency}
              today={businessDate(ctx.timeZone)}
              includesTax={o.pricesIncludeTax}
            />
          ) : null}
        </Card>

        {item.kind === "COMBO" ? (
          <Card title={t("menu.components")}>
            {item.components.length === 0 ? (
              <p className="text-muted mb-4 text-sm">{t("menu.noComponents")}</p>
            ) : (
              <ul className="divide-border mb-4 divide-y text-sm">
                {item.components.map((c) => (
                  <li key={c.componentId} className="flex items-center justify-between gap-2 py-2">
                    <span>
                      <span className="ltr-value font-mono text-xs">{c.component.code}</span>{" "}
                      <bdi>{c.component.name}</bdi> ×{" "}
                      <span className="ltr-value">{c.quantity.toFixed()}</span>
                    </span>
                    {manage ? (
                      <ConfirmActionButton
                        action={removeComboComponentAction.bind(
                          null,
                          orgSlug,
                          item.id,
                          c.componentId,
                        )}
                        label={t("menu.remove")}
                        variant="secondary"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {o ? (
              <ComboComponentForm
                action={addComboComponentAction.bind(null, orgSlug, item.id)}
                items={o.items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))}
              />
            ) : null}
          </Card>
        ) : null}

        <Card title={t("menu.modifierGroups")}>
          {item.modifierGroups.length === 0 ? (
            <p className="text-muted mb-4 text-sm">{t("menu.noGroups")}</p>
          ) : (
            <ul className="divide-border mb-4 divide-y text-sm">
              {item.modifierGroups.map(({ group: g }) => (
                <li key={g.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">
                      <bdi>{(locale === "ar" && g.nameAr) || g.name}</bdi>
                    </span>{" "}
                    <span className="text-muted text-xs">
                      {t("menu.selectRange", { min: g.minSelect, max: g.maxSelect })}
                    </span>
                    <span className="text-muted block text-xs">
                      {g.options
                        .map(
                          (op) =>
                            `${(locale === "ar" && op.nameAr) || op.name} (${delta(op.priceDelta)})`,
                        )
                        .join(" · ")}
                    </span>
                  </span>
                  {manage ? (
                    <ConfirmActionButton
                      action={detachModifierGroupAction.bind(null, orgSlug, item.id, g.id)}
                      label={t("menu.remove")}
                      variant="secondary"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {o ? (
            <AttachGroupForm
              action={attachModifierGroupAction.bind(null, orgSlug, item.id)}
              groups={o.groups
                .filter((g) => !item.modifierGroups.some((m) => m.groupId === g.id))
                .map((g) => ({ value: g.id, label: g.name }))}
            />
          ) : null}
        </Card>

        <Card title={t("menu.availability")}>
          {!o ? (
            item.unavailable.length === 0 ? (
              <p className="text-sm">{t("menu.everywhere")}</p>
            ) : (
              <p className="text-sm">
                {t("menu.notAt")}: {item.unavailable.map((u) => u.branch.code).join(", ")}
              </p>
            )
          ) : o.branches.length === 0 ? (
            <EmptyState title={t("menu.noBranches")} />
          ) : (
            <ul className="divide-border divide-y text-sm">
              {o.branches.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between gap-2 py-2"
                  data-testid={`availability-${b.code}`}
                >
                  <span>
                    {b.code} — {b.name}{" "}
                    <Badge tone={off.has(b.id) ? "muted" : "success"}>
                      {t(off.has(b.id) ? "menu.notOffered" : "menu.offered")}
                    </Badge>
                  </span>
                  <ConfirmActionButton
                    action={setItemAvailabilityAction.bind(
                      null,
                      orgSlug,
                      item.id,
                      b.id,
                      off.has(b.id),
                    )}
                    label={t(off.has(b.id) ? "menu.offer" : "menu.stopOffering")}
                    variant="secondary"
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {o ? (
          <Card title={t("menu.edit")}>
            <MenuItemForm
              action={updateMenuItemAction.bind(null, orgSlug, item.id)}
              submitLabel={t("common.save")}
              kindFixed
              categories={o.categories.map((c) => ({
                value: c.id,
                label: (locale === "ar" && c.nameAr) || c.name,
              }))}
              recipes={o.dishes.map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` }))}
              products={o.products.map((p) => ({
                value: p.id,
                label: `${p.sku} — ${p.nameEn} (${p.baseUom.code})`,
              }))}
              taxCodes={o.taxCodes.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))}
              defaults={{
                code: item.code,
                name: item.name,
                nameAr: item.nameAr ?? undefined,
                description: item.description ?? undefined,
                categoryId: item.categoryId,
                kind: item.kind,
                recipeId: item.recipeId ?? undefined,
                productId: item.productId ?? undefined,
                productQuantity: item.productQuantity?.toFixed(),
                taxCodeId: item.taxCodeId ?? undefined,
                barcode: item.barcode ?? undefined,
                sortOrder: String(item.sortOrder),
              }}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
