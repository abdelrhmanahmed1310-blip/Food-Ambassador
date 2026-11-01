import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ModifierGroupForm, ModifierOptionForm } from "@/components/menu/forms";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listModifierGroups, menuFormOptions } from "@/modules/menu/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import {
  addModifierOptionAction,
  createModifierGroupAction,
  setModifierOptionArchivedAction,
} from "../actions";

export default async function ModifiersPage({ params }: PageProps<"/o/[orgSlug]/menu/modifiers">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "menu.view")) notFound();
  const manage = hasPermission(ctx.grants, "menu.manage");
  const [t, locale, money, groups, o] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    listModifierGroups(ctx),
    manage ? menuFormOptions(ctx) : Promise.resolve(null),
  ]);
  const recipes = (o?.recipes ?? []).map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` }));
  const products = (o?.products ?? []).map((p) => ({
    value: p.id,
    label: `${p.sku} — ${p.nameEn} (${p.baseUom.code})`,
  }));
  return (
    <>
      <PageHeader
        title={t("menu.modifiers")}
        description={t("menu.modifiersIntro")}
        actions={
          <LinkButton href={`/o/${orgSlug}/menu`} variant="secondary">
            {t("menu.title")}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        {groups.length === 0 ? <EmptyState title={t("menu.noGroups")} /> : null}
        {groups.map((g) => (
          <Card
            key={g.id}
            title={`${(locale === "ar" && g.nameAr) || g.name} · ${t("menu.selectRange", { min: g.minSelect, max: g.maxSelect })}`}
          >
            <div className="space-y-4" data-testid={`group-${g.name}`}>
              {g.options.length === 0 ? (
                <p className="text-muted text-sm">{t("menu.noOptions")}</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {g.options.map((op) => (
                    <li
                      key={op.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span>
                        <bdi>{(locale === "ar" && op.nameAr) || op.name}</bdi>{" "}
                        <span className="ltr-value tabular-nums">
                          {op.priceDelta.isNegative() ? "" : "+"}
                          {money.money(op.priceDelta)}
                        </span>
                        {op.recipe || op.product ? (
                          <span className="text-muted text-xs">
                            {" "}
                            ·{" "}
                            {t("menu.usesStock", {
                              what: op.recipe?.code ?? op.product?.sku ?? "",
                              qty: op.quantity?.toFixed() ?? "",
                            })}
                          </span>
                        ) : null}{" "}
                        {op.archivedAt ? <Badge tone="muted">{t("menu.archived")}</Badge> : null}
                      </span>
                      {manage ? (
                        <ConfirmActionButton
                          action={setModifierOptionArchivedAction.bind(
                            null,
                            orgSlug,
                            op.id,
                            !op.archivedAt,
                          )}
                          label={t(op.archivedAt ? "menu.restore" : "menu.archive")}
                          variant="secondary"
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {manage ? (
                <ModifierOptionForm
                  action={addModifierOptionAction.bind(null, orgSlug, g.id)}
                  recipes={recipes}
                  products={products}
                />
              ) : null}
            </div>
          </Card>
        ))}
        {manage ? (
          <Card title={t("menu.addGroup")}>
            <ModifierGroupForm action={createModifierGroupAction.bind(null, orgSlug)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
