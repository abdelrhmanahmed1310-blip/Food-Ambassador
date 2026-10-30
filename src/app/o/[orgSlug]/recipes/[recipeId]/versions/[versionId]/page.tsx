import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { CostBreakdown } from "@/components/recipes/breakdown";
import { IngredientForm, VersionForm } from "@/components/recipes/forms";
import {
  Alert,
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
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { calculateVersionCost, costWarehouseOptions } from "@/modules/recipes/costs";
import { COST_POLICIES } from "@/modules/recipes/costing";
import { getVersion, subRecipeOptions } from "@/modules/recipes/recipes";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  moneyFormatter,
  productName,
  quantityFormatter,
  unitOptions,
} from "@/server/inventory-view";
import {
  activateVersionAction,
  addIngredientAction,
  discardDraftAction,
  removeIngredientAction,
  saveSnapshotAction,
  updateVersionAction,
} from "../../../actions";

const STATUS_TONE = { ACTIVE: "success", DRAFT: "neutral", RETIRED: "muted" } as const;

export default async function RecipeVersionPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/recipes/[recipeId]/versions/[versionId]">) {
  const { orgSlug, recipeId, versionId } = await params;
  if (!isUuid(versionId) || !isUuid(recipeId)) notFound();
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const version = await notFoundOnAppError(getVersion(ctx, versionId));
  if (version.recipeId !== recipeId) notFound();
  const recipe = version.recipe;
  const [t, locale, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const editing = version.can.edit;
  const [products, units, subs] = editing
    ? await Promise.all([listProductOptions(ctx), listUnits(ctx), subRecipeOptions(ctx, recipe.id)])
    : [[], [], []];
  const policy = COST_POLICIES.find((p) => p === sp.policy) ?? "AVERAGE";
  const warehouseId =
    typeof sp.warehouseId === "string" && isUuid(sp.warehouseId) ? sp.warehouseId : undefined;
  const [live, warehouses] = version.can.costs
    ? await Promise.all([
        calculateVersionCost(ctx, version.id, { policy, warehouseId }),
        costWarehouseOptions(ctx),
      ])
    : [null, []];
  const base = `/o/${orgSlug}/recipes/${recipe.id}`;
  const recipeName = (locale === "ar" && recipe.nameAr) || recipe.name;
  const ingredientLabel = (i: (typeof version.ingredients)[number]) =>
    i.product
      ? `${i.product.sku} — ${productName(i.product, locale)}`
      : `${i.subRecipe?.code} — ${(locale === "ar" && i.subRecipe?.nameAr) || i.subRecipe?.name}`;
  return (
    <>
      <PageHeader
        title={`${recipe.code} · ${t("recipes.versionNo", { no: version.versionNo })}`}
        description={recipeName}
        actions={
          <>
            <Badge tone={STATUS_TONE[version.status]}>
              {t(`recipes.statuses.${version.status}`)}
            </Badge>
            <Link
              href={`${base}/versions/${version.id}/card`}
              className="text-primary text-sm hover:underline"
            >
              {t("recipes.card")}
            </Link>
            <Link href={base} className="text-primary text-sm hover:underline">
              {t("recipes.allVersions")}
            </Link>
          </>
        }
      />
      <div className="space-y-6">
        {version.status !== "DRAFT" ? <Alert tone="info">{t("recipes.lockedHint")}</Alert> : null}
        <Card>
          <DescriptionList
            items={[
              { label: t("recipes.type"), value: t(`recipes.types.${recipe.type}`) },
              {
                label: t("recipes.yield"),
                value: (
                  <span className="ltr-value tabular-nums">
                    {fmt(version.yieldQuantity)} {version.yieldUom.code}
                  </span>
                ),
              },
              {
                label: t("recipes.portions"),
                value: version.portions ? (
                  <span className="ltr-value tabular-nums">{fmt(version.portions)}</span>
                ) : (
                  "—"
                ),
              },
              {
                label: t("purchasing.createdBy"),
                value: <bdi>{version.names.createdBy ?? "—"}</bdi>,
              },
              ...(version.activatedAt
                ? [
                    {
                      label: t("recipes.activatedBy"),
                      value: <bdi>{version.names.activatedBy ?? "—"}</bdi>,
                    },
                  ]
                : []),
              { label: t("common.note"), value: version.note ?? "—" },
            ]}
          />
        </Card>

        {version.method && !editing ? (
          <Card title={t("recipes.method")}>
            <p className="text-sm whitespace-pre-line">{version.method}</p>
          </Card>
        ) : null}

        <Card title={t("recipes.ingredients")}>
          {version.ingredients.length === 0 ? (
            <EmptyState title={t("recipes.noIngredients")} />
          ) : (
            <Table label={t("recipes.ingredients")}>
              <thead>
                <tr>
                  <Th>{t("recipes.ingredient")}</Th>
                  <Th>{t("recipes.netQuantity")}</Th>
                  <Th>{t("recipes.wastePercent")}</Th>
                  <Th>{t("common.note")}</Th>
                  {editing ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {version.ingredients.map((i) => (
                  <tr key={i.id}>
                    <Td>
                      {i.subRecipe ? (
                        <Link
                          href={`/o/${orgSlug}/recipes/${i.subRecipe.id}`}
                          className="text-primary hover:underline"
                        >
                          {ingredientLabel(i)}
                        </Link>
                      ) : (
                        ingredientLabel(i)
                      )}
                      {i.subRecipe ? (
                        <span className="text-muted block text-xs">
                          {t("recipes.types.PREPARATION")}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {fmt(i.quantity)} {i.uom.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value">{fmt(i.wasteFraction.times(100))} %</span>
                    </Td>
                    <Td>{i.note ?? "—"}</Td>
                    {editing ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeIngredientAction.bind(null, orgSlug, version.id, i.id)}
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
          {editing ? (
            <div className="mt-4">
              <IngredientForm
                action={addIngredientAction.bind(null, orgSlug, version.id)}
                items={[
                  ...products.map((p) => ({
                    value: `product:${p.id}`,
                    label: `${p.sku} — ${productName(p, locale)} (${p.baseUom.code})`,
                  })),
                  ...subs.map((s) => ({
                    value: `recipe:${s.id}`,
                    label: `${t("recipes.types.PREPARATION")}: ${s.code} — ${(locale === "ar" && s.nameAr) || s.name}`,
                  })),
                ]}
                units={unitOptions(units, locale)}
              />
            </div>
          ) : null}
        </Card>

        {live ? (
          <Card title={t("recipes.liveCost")}>
            <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t("recipes.policy")}</span>
                <select
                  name="policy"
                  defaultValue={policy}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                >
                  {COST_POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {t(`recipes.policies.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t("recipes.averageFrom")}</span>
                <select
                  name="warehouseId"
                  defaultValue={warehouseId ?? ""}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                >
                  <option value="">{t("recipes.wholeOrganization")}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
              >
                {t("recipes.recalculate")}
              </button>
            </form>
            <p className="text-muted mb-3 text-sm">{t("recipes.policyHint")}</p>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="border-border rounded-lg border p-3">
                <p className="text-muted text-xs">{t("recipes.totalCost")}</p>
                <p
                  className="ltr-value text-lg font-semibold tabular-nums"
                  data-testid="recipe-total"
                >
                  {money.money(live.cost.totalCost)}
                </p>
              </div>
              <div className="border-border rounded-lg border p-3">
                <p className="text-muted text-xs">{t("recipes.costPerPortion")}</p>
                <p
                  className="ltr-value text-lg font-semibold tabular-nums"
                  data-testid="recipe-portion"
                >
                  {live.cost.costPerPortion ? money.money(live.cost.costPerPortion) : "—"}
                </p>
              </div>
              <div className="border-border rounded-lg border p-3">
                <p className="text-muted text-xs">{t("recipes.costPerYieldUnit")}</p>
                <p className="ltr-value text-lg font-semibold tabular-nums">
                  {money.unitCost(live.cost.costPerYieldUnit)} / {live.cost.yieldUnit}
                </p>
              </div>
            </div>
            {live.cost.missingCount > 0 ? (
              <Alert tone="error">
                {t("recipes.incomplete", { count: live.cost.missingCount })}
              </Alert>
            ) : null}
            {version.ingredients.length > 0 ? (
              <div className="mt-4">
                <CostBreakdown
                  cost={live.cost}
                  names={live.names}
                  locale={locale}
                  money={money.money}
                  unitCost={money.unitCost}
                  fmt={fmt}
                />
              </div>
            ) : null}
            {version.status !== "DRAFT" ? (
              <div className="mt-4">
                <ConfirmActionButton
                  action={saveSnapshotAction.bind(null, orgSlug, version.id, {
                    policy,
                    warehouseId,
                  })}
                  label={t("recipes.saveSnapshot")}
                  variant="secondary"
                />
              </div>
            ) : null}
          </Card>
        ) : null}

        {editing ? (
          <>
            <Card title={t("recipes.editVersion")}>
              <VersionForm
                action={updateVersionAction.bind(null, orgSlug, version.id)}
                units={unitOptions(
                  units.filter((u) => u.factorToBase !== null),
                  locale,
                )}
                defaults={{
                  yieldQuantity: version.yieldQuantity.toFixed(),
                  yieldUomId: version.yieldUom.id,
                  portions: version.portions?.toFixed(),
                  note: version.note ?? undefined,
                  method: version.method ?? undefined,
                }}
              />
            </Card>
            <Card>
              <p className="text-muted mb-3 text-sm">{t("recipes.activateHint")}</p>
              <div className="flex flex-wrap gap-3">
                {version.can.activate ? (
                  <ConfirmActionButton
                    action={activateVersionAction.bind(null, orgSlug, version.id)}
                    label={t("recipes.activate")}
                    confirmMessage={t("recipes.confirmActivate")}
                    variant="primary"
                  />
                ) : null}
                {version.versionNo > 1 ? (
                  <ConfirmActionButton
                    action={discardDraftAction.bind(null, orgSlug, version.id)}
                    label={t("recipes.discardDraft")}
                    confirmMessage={t("recipes.confirmDiscard")}
                    variant="danger"
                  />
                ) : null}
              </div>
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
