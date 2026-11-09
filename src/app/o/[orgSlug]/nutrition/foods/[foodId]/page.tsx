import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import { NutrientAmount } from "@/components/nutrition/engine-view";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import {
  foodNutrition,
  getFood,
  listCategories,
  QUANTITY_UNITS,
} from "@/modules/nutrition/engine/foods";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { AppError } from "@/server/errors";
import { quantityFormatter } from "@/server/inventory-view";
import { addPortionAction, refreshFoodAction, updateFoodAction } from "../../actions";
import { Tabs } from "../../tabs";

const GROUPS = [
  "ENERGY",
  "PROXIMATES",
  "CARBOHYDRATES",
  "LIPIDS",
  "MINERALS",
  "VITAMINS",
  "AMINO_ACIDS",
  "OTHER",
] as const;

/** One food: every nutrient with its status, a serving calculator, servings, names and history (ADR-132). */
export default async function FoodProfilePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/nutrition/foods/[foodId]">) {
  const { orgSlug, foodId } = await params;
  if (!isUuid(foodId)) notFound();
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const locale = await getLocale();
  const f = await notFoundOnAppError(getFood(ctx, foodId, { lang: locale }));
  const [t, tRules, format, fmt, categories] = await Promise.all([
    getTranslations("nutritionEngine"),
    getTranslations("rules"),
    getFormatter(),
    quantityFormatter(),
    listCategories(ctx),
  ]);
  const manage = hasPermission(ctx.grants, "nutrition.manage");
  const food = f.food;
  const labels = {
    MISSING: t("values.MISSING"),
    BELOW_DETECTION: t("values.BELOW_DETECTION"),
    NOT_APPLICABLE: t("values.NOT_APPLICABLE"),
    CALCULATED: t("values.CALCULATED"),
  };
  const when = (v: Date | null) =>
    v
      ? format.dateTime(v, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const day = (v: Date | string | null) =>
    v ? format.dateTime(new Date(v), { dateStyle: "medium", timeZone: "UTC" }) : "—";
  const nName = (n: { name: string; nameAr: string | null }) =>
    (locale === "ar" && n.nameAr) || n.name;

  // Serving calculator (GET form): nothing is guessed; problems are shown as such.
  const calcInput = {
    quantity: typeof sp.quantity === "string" ? sp.quantity : undefined,
    unit: typeof sp.unit === "string" ? sp.unit : undefined,
    portionId: typeof sp.portionId === "string" && sp.portionId ? sp.portionId : undefined,
  };
  let calc: Awaited<ReturnType<typeof foodNutrition>> | null = null;
  let calcError: string | null = null;
  if (calcInput.quantity) {
    try {
      calc = await foodNutrition(ctx, food.id, calcInput);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const rule = error.details?.rule;
      calcError = typeof rule === "string" && tRules.has(rule) ? tRules(rule) : error.message;
    }
  }
  const openIssues = f.issues.filter((i) => i.status === "OPEN");

  return (
    <>
      <PageHeader
        title={food.displayName}
        description={
          <>
            {t(`sources.${food.source as "MANUAL"}`)}
            <span className="ltr-value"> · {food.sourceId}</span>
            {food.dataType ? <span className="ltr-value"> · {food.dataType}</span> : null}
            {food.brand ? (
              <>
                {" · "}
                <bdi>{food.brand}</bdi>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {food.verified ? (
              <Badge tone="success">{t("verified")}</Badge>
            ) : (
              <Badge tone="muted">{t("unverified")}</Badge>
            )}
            {food.stale ? <Badge tone="warning">{t("stale")}</Badge> : null}
            {food.archivedAt ? <Badge tone="danger">{t("archived")}</Badge> : null}
          </>
        }
      />
      <Tabs orgSlug={orgSlug} current="foods" />
      <div className="space-y-6">
        {!food.verified ? <Alert tone="info">{t("notVerifiedNote")}</Alert> : null}
        {openIssues.length > 0 ? (
          <Alert tone="error">
            {t("openIssuesOnFood", { count: openIssues.length })}{" "}
            <Link href={`/o/${orgSlug}/nutrition/quality`} className="underline">
              {t("tabs.quality")}
            </Link>
          </Alert>
        ) : null}

        <Card title={t("calculator")}>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("quantity")}</span>
              <input
                name="quantity"
                inputMode="decimal"
                defaultValue={calcInput.quantity ?? "100"}
                className="ltr-value border-border bg-surface w-28 rounded-md border px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("unit")}</span>
              <select
                name="unit"
                defaultValue={calcInput.unit ?? (food.basis === "PER_100ML" ? "ml" : "g")}
                className="border-border bg-surface rounded-md border px-3 py-2"
              >
                {QUANTITY_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {t(`units.${u}`)}
                  </option>
                ))}
              </select>
            </label>
            {f.portions.length > 0 ? (
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t("serving")}</span>
                <select
                  name="portionId"
                  defaultValue={calcInput.portionId ?? ""}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                >
                  <option value="">—</option>
                  {f.portions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayDescription}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button type="submit" className={buttonClass("secondary")}>
              {t("calculate")}
            </button>
          </form>
          <p className="text-muted mt-2 text-xs">{t("densityNote")}</p>
          {calcError ? (
            <div className="mt-3">
              <Alert tone="error">{calcError}</Alert>
            </div>
          ) : null}
          {calc ? (
            <div className="mt-4" data-testid="calc-result">
              <p className="mb-2 text-sm">
                {t("calcFor", {
                  quantity: fmt(calc.quantity),
                  unit: t(`units.${calc.unit as "g"}`),
                })}
                {calc.grams ? <span className="ltr-value"> = {fmt(calc.grams)} g</span> : null}
              </p>
              <Table label={t("calculator")}>
                <tbody>
                  {calc.values
                    .filter((v) => f.nutrients.some((n) => n.code === v.code && n.isCore))
                    .map((v) => {
                      const n = f.nutrients.find((x) => x.code === v.code)!;
                      return (
                        <tr key={v.code}>
                          <Td>{nName(n)}</Td>
                          <Td>
                            <NutrientAmount
                              amount={v.amount}
                              unit={v.unit}
                              status={v.status}
                              labels={labels}
                              fmt={fmt}
                            />
                          </Td>
                        </tr>
                      );
                    })}
                </tbody>
              </Table>
            </div>
          ) : null}
        </Card>

        <Card title={t("nutrientsPer", { basis: food.basis === "PER_100ML" ? "100 ml" : "100 g" })}>
          {f.missingCore.length > 0 ? (
            <div className="mb-4 text-sm" data-testid="missing-core">
              <p className="mb-2 font-medium">{t("missingCore")}</p>
              <ul className="flex flex-wrap gap-2">
                {f.missingCore.map((m) => (
                  <li
                    key={m.code}
                    className="border-border flex items-center gap-2 rounded-md border px-2 py-1"
                  >
                    <span>{m.displayName}</span>
                    <span className="text-warning text-xs">{labels.MISSING}</span>
                    {manage ? (
                      <ConfirmActionButton
                        action={updateFoodAction.bind(null, orgSlug, food.id)}
                        label={t("markNotApplicable")}
                        variant="secondary"
                        hidden={{ notApplicable: m.code ?? "", naValue: "true" }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {f.nutrients.length === 0 ? (
            <EmptyState title={t("noValues")} />
          ) : (
            GROUPS.filter((g) => f.nutrients.some((n) => n.group === g)).map((g) => (
              <div key={g} className="mb-4">
                <h3 className="mb-2 text-sm font-semibold">{t(`groups.${g}`)}</h3>
                <Table label={t(`groups.${g}`)}>
                  <thead>
                    <tr>
                      <Th>{t("nutrient")}</Th>
                      <Th>{t("amount")}</Th>
                      <Th>{t("asPublished")}</Th>
                      <Th>{t("derivation")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.nutrients
                      .filter((n) => n.group === g)
                      .map((n) => (
                        <tr
                          key={n.nutrientId}
                          data-testid={`nutrient-${n.code ?? n.sourceNutrientId}`}
                        >
                          <Td>
                            {nName(n)}
                            {n.isCore ? <span className="text-muted ms-1 text-xs">●</span> : null}
                          </Td>
                          <Td>
                            <NutrientAmount
                              amount={n.amount}
                              unit={n.unit}
                              status={n.status}
                              labels={labels}
                              fmt={fmt}
                            />
                            {manage && n.status === "NOT_APPLICABLE" && n.code ? (
                              <span className="ms-2 inline-block">
                                <ConfirmActionButton
                                  action={updateFoodAction.bind(null, orgSlug, food.id)}
                                  label={t("clearNotApplicable")}
                                  variant="secondary"
                                  hidden={{ notApplicable: n.code, naValue: "false" }}
                                />
                              </span>
                            ) : null}
                          </Td>
                          <Td className="ltr-value text-muted text-xs">
                            {n.originalAmount !== null
                              ? `${fmt(n.originalAmount)} ${n.originalUnit ?? ""}`
                              : "—"}
                          </Td>
                          <Td className="text-muted text-xs">
                            <bdi>
                              {n.derivationDescription ??
                                n.derivationCode ??
                                (n.status === "CALCULATED" ? labels.CALCULATED : "—")}
                            </bdi>
                          </Td>
                        </tr>
                      ))}
                  </tbody>
                </Table>
              </div>
            ))
          )}
          <p className="text-muted text-xs">{t("valuesNote")}</p>
        </Card>

        <Card title={t("servings")}>
          {f.portions.length === 0 ? (
            <EmptyState title={t("noServings")} />
          ) : (
            <Table label={t("servings")}>
              <thead>
                <tr>
                  <Th>{t("serving")}</Th>
                  <Th>{t("gramWeight")}</Th>
                  <Th>{t("millilitres")}</Th>
                  <Th>{t("origin")}</Th>
                </tr>
              </thead>
              <tbody>
                {f.portions.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      <bdi>{p.displayDescription}</bdi>
                    </Td>
                    <Td className="ltr-value tabular-nums">
                      {p.gramWeight ? `${fmt(p.gramWeight)} g` : "—"}
                    </Td>
                    <Td className="ltr-value tabular-nums">
                      {p.millilitres ? `${fmt(p.millilitres)} ml` : "—"}
                    </Td>
                    <Td className="text-xs">
                      {p.manual ? t("manualEntry") : t(`sources.${food.source as "MANUAL"}`)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {manage ? (
            <div className="mt-4">
              <ActionForm
                action={addPortionAction.bind(null, orgSlug, food.id)}
                submitLabel={t("addServing")}
                className="grid gap-3 sm:grid-cols-4"
              >
                <TextField name="description" label={t("servingDescription")} required />
                <TextField name="descriptionAr" label={t("servingDescriptionAr")} dir="rtl" />
                <TextField
                  name="gramWeight"
                  label={t("gramWeight")}
                  inputMode="decimal"
                  dir="ltr"
                />
                <TextField
                  name="millilitres"
                  label={t("millilitres")}
                  inputMode="decimal"
                  dir="ltr"
                />
              </ActionForm>
            </div>
          ) : null}
        </Card>

        <Card title={t("details")}>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">{t("nameEn")}</dt>
              <dd>
                <bdi>{food.name}</bdi>
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t("nameAr")}</dt>
              <dd dir="rtl">{food.nameAr ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("category")}</dt>
              <dd>{food.category ? nName(food.category) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("identifiers")}</dt>
              <dd className="ltr-value font-mono text-xs">
                {f.identifiers.map((i) => `${i.kind}: ${i.value}`).join(" · ") || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t("published")}</dt>
              <dd className="ltr-value">{day(food.publicationDate)}</dd>
            </div>
            <div>
              <dt className="text-muted">{t("lastFetched")}</dt>
              <dd className="ltr-value">{when(food.lastFetchedAt)}</dd>
            </div>
            {food.ingredientsText ? (
              <div className="sm:col-span-2">
                <dt className="text-muted">{t("ingredientsDeclared")}</dt>
                <dd dir="auto">{food.ingredientsText}</dd>
                <dd className="text-muted mt-1 text-xs">{t("notTranslated")}</dd>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <dt className="text-muted">{t("linkedProduct")}</dt>
              <dd>
                {f.linkedProduct ? (
                  <Link
                    href={`/o/${orgSlug}/catalog/products/${f.linkedProduct.id}/nutrition`}
                    className="text-primary hover:underline"
                  >
                    <span className="ltr-value font-mono">{f.linkedProduct.sku}</span> —{" "}
                    <bdi>
                      {(locale === "ar" && f.linkedProduct.nameAr) || f.linkedProduct.nameEn}
                    </bdi>
                  </Link>
                ) : (
                  "—"
                )}{" "}
                {manage ? (
                  <Link
                    href={`/o/${orgSlug}/catalog/library/${food.id}`}
                    className="text-primary ms-2 text-xs underline"
                  >
                    {t("linkToProduct")}
                  </Link>
                ) : null}
              </dd>
            </div>
          </dl>
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-semibold">{t("aliases")}</h3>
            {f.aliases.length === 0 ? (
              <p className="text-muted text-sm">—</p>
            ) : (
              <ul className="flex flex-wrap gap-2 text-sm">
                {f.aliases.map((a) => (
                  <li
                    key={a.id}
                    className="border-border flex items-center gap-2 rounded-md border px-2 py-1"
                  >
                    <bdi>{a.name}</bdi>
                    <span className="text-muted text-xs uppercase">{a.locale}</span>
                    {manage ? (
                      <ConfirmActionButton
                        action={updateFoodAction.bind(null, orgSlug, food.id)}
                        label={t("remove")}
                        variant="secondary"
                        hidden={{ removeAliasId: a.id }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {manage ? (
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <ActionForm
                action={updateFoodAction.bind(null, orgSlug, food.id)}
                submitLabel={t("save")}
              >
                <TextField
                  name="nameAr"
                  label={t("nameAr")}
                  defaultValue={food.nameAr ?? ""}
                  dir="rtl"
                />
                <SelectField
                  name="categoryId"
                  label={t("category")}
                  defaultValue={food.category?.id ?? ""}
                  placeholder="—"
                  options={categories.map((c) => ({ value: c.id, label: nName(c) }))}
                />
              </ActionForm>
              <ActionForm
                action={updateFoodAction.bind(null, orgSlug, food.id)}
                submitLabel={t("addAlias")}
              >
                <TextField name="aliasName" label={t("alias")} required dir="auto" />
                <SelectField
                  name="aliasLocale"
                  label={t("language")}
                  defaultValue="ar"
                  options={[
                    { value: "ar", label: "العربية" },
                    { value: "en", label: "English" },
                  ]}
                />
              </ActionForm>
            </div>
          ) : null}
        </Card>

        {manage ? (
          <Card title={t("maintenance")}>
            <div className="flex flex-wrap items-start gap-4">
              <ConfirmActionButton
                action={updateFoodAction.bind(null, orgSlug, food.id)}
                label={food.verified ? t("unverify") : t("verify")}
                variant={food.verified ? "secondary" : "primary"}
                confirmMessage={food.verified ? undefined : t("verifyConfirm")}
                hidden={{ verified: food.verified ? "false" : "true" }}
              />
              {food.source === "USDA_FDC" ? (
                <ConfirmActionButton
                  action={refreshFoodAction.bind(null, orgSlug, food.id)}
                  label={t("refreshNow")}
                  variant="secondary"
                />
              ) : null}
              {food.archivedAt ? (
                <ConfirmActionButton
                  action={updateFoodAction.bind(null, orgSlug, food.id)}
                  label={t("restore")}
                  variant="secondary"
                  hidden={{ archived: "false" }}
                />
              ) : null}
            </div>
            {food.archivedAt ? null : (
              <div className="mt-4 max-w-md">
                <ActionForm
                  action={updateFoodAction.bind(null, orgSlug, food.id)}
                  submitLabel={t("archive")}
                  submitVariant="danger"
                >
                  <input type="hidden" name="archived" value="true" />
                  <TextField name="archiveReason" label={t("archiveReason")} required />
                </ActionForm>
              </div>
            )}
          </Card>
        ) : null}

        <Card title={t("history")}>
          {f.versions.length === 0 ? (
            <p className="text-muted text-sm">{t("noVersions")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {f.versions.map((v) => (
                <li key={v.id}>
                  <span className="ltr-value">{when(v.fetchedAt)}</span> ·{" "}
                  {t(`via.${v.via as "API"}`)}
                  {v.publicationDate ? (
                    <span className="ltr-value"> · {day(v.publicationDate)}</span>
                  ) : null}
                  <span className="ltr-value text-muted font-mono text-xs">
                    {" "}
                    · {v.payloadHash.slice(0, 12)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
