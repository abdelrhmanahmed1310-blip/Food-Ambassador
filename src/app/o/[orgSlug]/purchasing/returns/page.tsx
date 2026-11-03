import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ReturnStatusBadge } from "@/components/procurement/badges";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listSupplierReturns, RETURN_STATUSES } from "@/modules/procurement/returns";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyIn } from "@/server/fx-view";

export default async function ReturnsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/returns">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.view")) notFound();
  const status = RETURN_STATUSES.find((s) => s === sp.status);
  const page = pageSchema.parse(sp.page);
  const [t, locale, format, result] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    listSupplierReturns(ctx, { status, page }),
  ]);
  const moneyOf = await moneyIn(result.items.map((r) => r.currency).concat(ctx.baseCurrency));
  const base = `/o/${orgSlug}/purchasing/returns`;
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border hover:bg-surface-muted"
    }`;
  return (
    <>
      <PageHeader
        title={t("returns.title")}
        description={t("returns.hint")}
        actions={
          holdsAnyGrant(ctx.grants, "purchasing.receive") ? (
            <LinkButton href={`${base}/new`}>{t("returns.new")}</LinkButton>
          ) : null
        }
      />
      <nav aria-label={t("common.status")} className="mb-4 flex flex-wrap gap-2">
        <Link href={base} className={chip(!status)} aria-current={!status ? "page" : undefined}>
          {t("common.all")}
        </Link>
        {RETURN_STATUSES.map((s) => (
          <Link
            key={s}
            href={`${base}?status=${s}`}
            className={chip(status === s)}
            aria-current={status === s ? "page" : undefined}
          >
            {t(`returns.statuses.${s}`)}
          </Link>
        ))}
      </nav>
      {result.total === 0 ? (
        <EmptyState title={t("returns.empty")} />
      ) : (
        <Table label={t("returns.title")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("purchasing.supplier")}</Th>
              <Th>{t("purchasing.deliverTo")}</Th>
              <Th>{t("returns.reason")}</Th>
              <Th>{t("returns.expectedCredit")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link
                    href={`${base}/${r.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {r.number}
                  </Link>
                  <span className="text-muted block text-xs">
                    {format.dateTime(r.postedAt ?? r.createdAt, {
                      dateStyle: "medium",
                      timeZone: ctx.timeZone,
                    })}
                  </span>
                </Td>
                <Td>{(locale === "ar" && r.supplier.nameAr) || r.supplier.name}</Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{r.warehouse.code}</span>
                </Td>
                <Td>{t(`returns.reasons.${r.reason}`)}</Td>
                <Td className="tabular-nums">
                  <span className="ltr-value whitespace-nowrap">
                    {moneyOf(r.currency).money(r.totalAmount)}
                  </span>
                </Td>
                <Td>
                  <ReturnStatusBadge status={r.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={base}
        params={{ status }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
