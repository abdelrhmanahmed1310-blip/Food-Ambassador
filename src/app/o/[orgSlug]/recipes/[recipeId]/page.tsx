import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { RecipeHeaderForm } from "@/components/recipes/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { listSnapshots } from "@/modules/recipes/costs";
import { businessDate } from "@/modules/inventory/rules";
import { listRecipePrices } from "@/modules/recipes/menu";
import { RecipePriceForm, TargetForm } from "@/components/recipes/forms";
import { RecipeTaxForm } from "@/components/tax/forms";
import { getTaxSetup } from "@/modules/tax/service";
import { getRecipe } from "@/modules/recipes/recipes";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, quantityFormatter } from "@/server/inventory-view";
import { hasPermission } from "@/modules/access/authorize";
import {
  addRecipePriceAction,
  createDraftVersionAction,
  setRecipeArchivedAction,
  setRecipeTargetAction,
  setRecipeTaxCodeAction,
  updateRecipeAction,
} from "../actions";

const STATUS_TONE = { ACTIVE: "success", DRAFT: "neutral", RETIRED: "muted" } as const;

export default async function RecipePage({ params }: PageProps<"/o/[orgSlug]/recipes/[recipeId]">) {
  const { orgSlug, recipeId } = await params;
  if (!isUuid(recipeId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const recipe = await notFoundOnAppError(getRecipe(ctx, recipeId));
  const costs = hasPermission(ctx.grants, "recipes.costs.view");
  const [t, locale, format, fmt, money, snapshots] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
    costs ? listSnapshots(ctx, recipe.id) : Promise.resolve([]),
  ]);
  const prices = recipe.type === "DISH" ? await listRecipePrices(ctx, recipe.id) : [];
  const taxCodes =
    recipe.type === "DISH" && recipe.can.edit
      ? (await getTaxSetup(ctx)).codes.filter((c) => !c.archivedAt)
      : [];
  const base = `/o/${orgSlug}/recipes/${recipe.id}`;
  const dt = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  return (
    <>
      <PageHeader
        title={`${recipe.code} — ${(locale === "ar" && recipe.nameAr) || recipe.name}`}
        description={t(`recipes.types.${recipe.type}`)}
        actions={
          <>
            {recipe.archivedAt ? <Badge tone="muted">{t("common.archived")}</Badge> : null}
            {recipe.can.newVersion ? (
              <ConfirmActionButton
                action={createDraftVersionAction.bind(null, orgSlug, recipe.id)}
                label={t("recipes.newVersion")}
                variant="primary"
              />
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card title={t("recipes.versions")}>
          <Table label={t("recipes.versions")}>
            <thead>
              <tr>
                <Th>{t("recipes.version")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("recipes.yield")}</Th>
                <Th>{t("recipes.ingredients")}</Th>
                <Th>{t("recipes.activatedAt")}</Th>
              </tr>
            </thead>
            <tbody>
              {recipe.versions.map((v) => (
                <tr key={v.id}>
                  <Td>
                    <Link
                      href={`${base}/versions/${v.id}`}
                      className="text-primary hover:underline"
                    >
                      {t("recipes.versionNo", { no: v.versionNo })}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[v.status]}>{t(`recipes.statuses.${v.status}`)}</Badge>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {fmt(v.yieldQuantity)} {v.yieldUom.code}
                      {v.portions
                        ? ` · ${t("recipes.portionsCount", { count: fmt(v.portions) })}`
                        : ""}
                    </span>
                  </Td>
                  <Td className="tabular-nums">{v._count.ingredients}</Td>
                  <Td className="whitespace-nowrap">{v.activatedAt ? dt(v.activatedAt) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        {recipe.type === "DISH" ? (
          <Card title={t("recipes.sellingPrices")}>
            {prices.length === 0 ? (
              <p className="text-muted mb-4 text-sm">{t("recipes.noPrices")}</p>
            ) : (
              <Table label={t("recipes.sellingPrices")}>
                <thead>
                  <tr>
                    <Th>{t("recipes.effectiveFrom")}</Th>
                    <Th>{t("recipes.sellingPrice")}</Th>
                    <Th>{t("common.note")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((p) => (
                    <tr key={p.id}>
                      <Td className="whitespace-nowrap">
                        {p.effectiveFrom.toISOString().slice(0, 10)}
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">{money.money(p.price)}</span>
                      </Td>
                      <Td>{p.note ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {recipe.can.edit ? (
              <div className="mt-4 grid gap-6 lg:grid-cols-2">
                <RecipePriceForm
                  action={addRecipePriceAction.bind(null, orgSlug, recipe.id)}
                  currency={ctx.baseCurrency}
                  today={businessDate(ctx.timeZone)}
                />
                {taxCodes.length > 0 ? (
                  <RecipeTaxForm
                    action={setRecipeTaxCodeAction.bind(null, orgSlug, recipe.id)}
                    codes={taxCodes.map((c) => ({
                      value: c.id,
                      label: `${c.code} — ${(locale === "ar" && c.nameAr) || c.name}`,
                    }))}
                    current={recipe.taxCodeId ?? undefined}
                  />
                ) : null}
                <TargetForm
                  action={setRecipeTargetAction.bind(null, orgSlug, recipe.id)}
                  label={t("recipes.recipeTarget")}
                  hint={t("recipes.recipeTargetHint")}
                  defaultValue={
                    recipe.targetFoodCostFraction
                      ? recipe.targetFoodCostFraction.times(100).toFixed()
                      : undefined
                  }
                />
              </div>
            ) : null}
          </Card>
        ) : null}

        {costs ? (
          <Card title={t("recipes.costHistory")}>
            {snapshots.length === 0 ? (
              <p className="text-muted text-sm">{t("recipes.noSnapshots")}</p>
            ) : (
              <Table label={t("recipes.costHistory")}>
                <thead>
                  <tr>
                    <Th>{t("common.date")}</Th>
                    <Th>{t("recipes.version")}</Th>
                    <Th>{t("recipes.policy")}</Th>
                    <Th>{t("recipes.totalCost")}</Th>
                    <Th>{t("recipes.costPerPortion")}</Th>
                    <Th>{t("recipes.costPerYieldUnit")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={s.id}>
                      <Td className="whitespace-nowrap">
                        <Link
                          href={`/o/${orgSlug}/recipes/snapshots/${s.id}`}
                          className="text-primary hover:underline"
                        >
                          {dt(s.calculatedAt)}
                        </Link>
                        <span className="text-muted block text-xs">
                          {t(`recipes.snapshotReasons.${s.reason}`)}
                        </span>
                      </Td>
                      <Td>{t("recipes.versionNo", { no: s.version.versionNo })}</Td>
                      <Td>
                        {t(`recipes.policies.${s.policy}`)}
                        {s.warehouse ? (
                          <span className="ltr-value text-muted block font-mono text-xs">
                            {s.warehouse.code}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {money.money(s.totalCost)}
                        </span>
                        {s.missingCount > 0 ? (
                          <span className="mt-1 block">
                            <Badge tone="warning">
                              {t("recipes.missingCount", { count: s.missingCount })}
                            </Badge>
                          </span>
                        ) : null}
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {s.costPerPortion ? money.money(s.costPerPortion) : "—"}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {money.unitCost(s.costPerYieldUnit)} / {s.version.yieldUom.code}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ) : null}

        {recipe.usedIn.length > 0 ? (
          <Card title={t("recipes.usedIn")}>
            <ul className="divide-border divide-y text-sm">
              {recipe.usedIn.map((u) => (
                <li key={u.version.id} className="py-2">
                  <Link
                    href={`/o/${orgSlug}/recipes/${u.version.recipe.id}/versions/${u.version.id}`}
                    className="text-primary hover:underline"
                  >
                    {u.version.recipe.code} —{" "}
                    {(locale === "ar" && u.version.recipe.nameAr) || u.version.recipe.name}
                  </Link>{" "}
                  · {t("recipes.versionNo", { no: u.version.versionNo })} (
                  {t(`recipes.statuses.${u.version.status}`)})
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {recipe.can.edit ? (
          <Card title={t("recipes.details")}>
            {recipe.description ? (
              <p className="text-muted mb-3 text-sm">{recipe.description}</p>
            ) : null}
            <RecipeHeaderForm
              action={updateRecipeAction.bind(null, orgSlug, recipe.id)}
              defaults={{
                name: recipe.name,
                nameAr: recipe.nameAr ?? undefined,
                description: recipe.description ?? undefined,
              }}
            />
          </Card>
        ) : recipe.versions.length === 0 ? (
          <EmptyState title={t("common.none")} />
        ) : null}

        {recipe.can.archive ? (
          <Card>
            <ConfirmActionButton
              action={setRecipeArchivedAction.bind(null, orgSlug, recipe.id, !recipe.archivedAt)}
              label={recipe.archivedAt ? t("common.restore") : t("common.archive")}
              confirmMessage={recipe.archivedAt ? undefined : t("recipes.confirmArchive")}
              variant="secondary"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
