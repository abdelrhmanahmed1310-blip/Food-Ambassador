import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { CreateCountForm } from "@/components/inventory/forms";
import { Pagination } from "@/components/ui/pagination";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listCounts } from "@/modules/inventory/counts";
import { warehouseOptions } from "@/modules/inventory/queries";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { placeOptions } from "@/server/inventory-view";
import { createCountAction } from "../actions";

export default async function CountsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/counts">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const page = pageSchema.parse((await searchParams).page);
  const [t, format, result] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listCounts(ctx, { page }),
  ]);
  const canCount = holdsAnyGrant(ctx.grants, "inventory.count");
  const places = canCount ? placeOptions(await warehouseOptions(ctx, "inventory.count")) : [];
  return (
    <>
      <PageHeader title={t("inventory.countsTitle")} description={t("inventory.countHint")} />
      <div className="space-y-6">
        {canCount && places.length > 0 ? (
          <Card title={t("inventory.newCountTitle")}>
            <CreateCountForm action={createCountAction.bind(null, orgSlug)} places={places} />
          </Card>
        ) : null}
        {result.items.length === 0 ? (
          <EmptyState title={t("inventory.noCounts")} />
        ) : (
          <Table label={t("inventory.countsTitle")}>
            <thead>
              <tr>
                <Th>{t("inventory.countNumber")}</Th>
                <Th>{t("common.warehouse")}</Th>
                <Th>{t("inventory.lines")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("common.date")}</Th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/inventory/counts/${c.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {c.number}
                    </Link>
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">
                      {c.warehouse.code}
                      {c.location ? ` / ${c.location.code}` : ""}
                    </span>
                  </Td>
                  <Td className="tabular-nums">{c._count.lines}</Td>
                  <Td>
                    <Badge
                      tone={
                        c.status === "POSTED"
                          ? "success"
                          : c.status === "CANCELLED"
                            ? "muted"
                            : "neutral"
                      }
                    >
                      {t(`inventory.countStatuses.${c.status}`)}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {format.dateTime(c.createdAt, { dateStyle: "medium", timeZone: ctx.timeZone })}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination
          basePath={`/o/${orgSlug}/inventory/counts`}
          params={{}}
          page={result.page}
          pageCount={result.pageCount}
          total={result.total}
        />
      </div>
    </>
  );
}
