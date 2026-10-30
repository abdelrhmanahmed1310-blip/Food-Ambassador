import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { SalesImportForm } from "@/components/sales/import-form";
import { Alert, Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { listSalesImports } from "@/modules/sales/imports";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { importSalesAction } from "./actions";

export default async function SalesPage({ params }: PageProps<"/o/[orgSlug]/sales">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "sales.view")) notFound();
  const canImport = holdsAnyGrant(ctx.grants, "sales.import");
  const [t, format, money, imports, warehouses] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    listSalesImports(ctx),
    canImport ? purchasingWarehouseOptions(ctx, "sales.import") : Promise.resolve([]),
  ]);
  const base = `/o/${orgSlug}/sales`;
  return (
    <>
      <PageHeader title={t("sales.title")} description={t("sales.hint")} />
      <div className="space-y-6">
        <Alert tone="info">{t("sales.noLiveIntegration")}</Alert>
        {canImport ? (
          <SalesImportForm
            action={importSalesAction.bind(null, orgSlug)}
            warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
            templateHref={`${base}/template`}
            detailBase={base}
          />
        ) : null}
        {imports.length === 0 ? (
          <EmptyState title={t("sales.empty")} />
        ) : (
          <Table label={t("sales.title")}>
            <thead>
              <tr>
                <Th>{t("purchasing.number")}</Th>
                <Th>{t("common.date")}</Th>
                <Th>{t("sales.warehouse")}</Th>
                <Th>{t("sales.lines")}</Th>
                <Th>{t("sales.netAmount")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => (
                <tr key={i.id}>
                  <Td>
                    <Link
                      href={`${base}/${i.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {i.number}
                    </Link>
                    {i.fileName ? (
                      <span className="text-muted block text-xs">{i.fileName}</span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {format.dateTime(i.postedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: ctx.timeZone,
                    })}
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{i.warehouse.code}</span>
                  </Td>
                  <Td className="tabular-nums">
                    {i.lineCount}
                    {i.skippedCount > 0 ? (
                      <span className="text-muted block text-xs">
                        {t("sales.skippedCount", { count: i.skippedCount })}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {i.netAmount ? money.money(i.netAmount) : "—"}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={i.status === "POSTED" ? "success" : "muted"}>
                      {t(`sales.statuses.${i.status}`)}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
