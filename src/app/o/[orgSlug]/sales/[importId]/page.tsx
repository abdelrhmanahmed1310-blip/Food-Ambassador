import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ReasonForm } from "@/components/procurement/forms";
import {
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getSalesImport } from "@/modules/sales/imports";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";
import { reverseSalesImportAction } from "../actions";

export default async function SalesImportPage({
  params,
}: PageProps<"/o/[orgSlug]/sales/[importId]">) {
  const { orgSlug, importId } = await params;
  if (!isUuid(importId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const imp = await notFoundOnAppError(getSalesImport(ctx, importId));
  const [t, locale, format, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const doc = (d: { id: string; number: string } | null) =>
    d ? (
      <Link
        href={`/o/${orgSlug}/inventory/documents/${d.id}`}
        className="ltr-value text-primary font-mono hover:underline"
      >
        {d.number}
      </Link>
    ) : (
      "—"
    );
  return (
    <>
      <PageHeader
        title={imp.number}
        description={`${imp.warehouse.code} — ${imp.warehouse.name}`}
        actions={
          <Badge tone={imp.status === "POSTED" ? "success" : "muted"}>
            {t(`sales.statuses.${imp.status}`)}
          </Badge>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("common.date"),
                value: format.dateTime(imp.postedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: ctx.timeZone,
                }),
              },
              { label: t("sales.file"), value: imp.fileName ?? "—" },
              {
                label: t("sales.lines"),
                value: `${imp.lineCount}${imp.skippedCount ? ` (${t("sales.skippedCount", { count: imp.skippedCount })})` : ""}`,
              },
              {
                label: t("sales.netAmount"),
                value: (
                  <span className="ltr-value tabular-nums">
                    {imp.netAmount ? money.money(imp.netAmount) : "—"}
                  </span>
                ),
              },
              ...(imp.costAmount !== null
                ? [
                    {
                      label: t("sales.costOfSales"),
                      value: (
                        <span className="ltr-value tabular-nums" data-testid="cost-of-sales">
                          {money.money(imp.costAmount)}
                        </span>
                      ),
                    },
                  ]
                : []),
              { label: t("sales.stockDocument"), value: doc(imp.document) },
              ...(imp.reversal
                ? [
                    {
                      label: t("sales.reversedWith"),
                      value: (
                        <>
                          {doc(imp.reversal)} — <bdi>{imp.reversalReason}</bdi>
                        </>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
        <Card title={t("sales.soldItems")}>
          <Table label={t("sales.soldItems")}>
            <thead>
              <tr>
                <Th>{t("import.row")}</Th>
                <Th>{t("common.date")}</Th>
                <Th>{t("sales.reference")}</Th>
                <Th>{t("sales.item")}</Th>
                <Th>{t("common.quantity")}</Th>
                <Th>{t("sales.netAmount")}</Th>
              </tr>
            </thead>
            <tbody>
              {imp.lines.map((l) => (
                <tr key={l.id}>
                  <Td className="tabular-nums">{l.rowNo}</Td>
                  <Td className="whitespace-nowrap">{l.soldOn.toISOString().slice(0, 10)}</Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{l.externalId}</span>
                    {l.channel ? (
                      <span className="text-muted block text-xs">{l.channel}</span>
                    ) : null}
                  </Td>
                  <Td>
                    {l.recipe ? (
                      <Link
                        href={`/o/${orgSlug}/recipes/${l.recipe.id}`}
                        className="text-primary hover:underline"
                      >
                        {l.recipe.code} — {(locale === "ar" && l.recipe.nameAr) || l.recipe.name}
                      </Link>
                    ) : l.product ? (
                      `${l.product.sku} — ${productName(l.product, locale)}`
                    ) : (
                      "—"
                    )}
                    {l.recipeVersion ? (
                      <span className="text-muted block text-xs">
                        {t("recipes.versionNo", { no: l.recipeVersion.versionNo })}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value">{fmt(l.quantity)}</span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {l.netAmount ? money.money(l.netAmount) : "—"}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title={t("sales.stockUsed")}>
          <Table label={t("sales.stockUsed")}>
            <thead>
              <tr>
                <Th>{t("inventory.product")}</Th>
                <Th>{t("inventory.lot")}</Th>
                <Th>{t("common.quantity")}</Th>
                {imp.costAmount !== null ? <Th>{t("inventory.value")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {imp.usage.map((u) => (
                <tr key={u.id}>
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
                    <span className="ltr-value whitespace-nowrap">
                      {fmt(u.quantity)} {u.product.baseUom.code}
                    </span>
                  </Td>
                  {u.value !== null ? (
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">{money.money(u.value)}</span>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        {imp.canReverse ? (
          <Card title={t("sales.reverse")}>
            <p className="text-muted mb-3 text-sm">{t("sales.reverseHint")}</p>
            <ReasonForm
              action={reverseSalesImportAction.bind(null, orgSlug, imp.id)}
              submitLabel={t("sales.reverse")}
              label={t("sales.reverseReason")}
              variant="danger"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
