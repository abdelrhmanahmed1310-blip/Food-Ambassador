import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { RequisitionStatusBadge } from "@/components/procurement/badges";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listRequisitions } from "@/modules/procurement/requisitions";
import { REQUISITION_STATUSES } from "@/modules/procurement/rules";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function RequisitionsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/requisitions">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (
    !holdsAnyGrant(ctx.grants, "purchasing.view") &&
    !holdsAnyGrant(ctx.grants, "purchasing.request")
  )
    notFound();
  const status = REQUISITION_STATUSES.find((s) => s === sp.status);
  const page = pageSchema.parse(sp.page);
  const [t, format, result] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listRequisitions(ctx, { status, page }),
  ]);
  const base = `/o/${orgSlug}/purchasing/requisitions`;
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border hover:bg-surface-muted"
    }`;
  return (
    <>
      <PageHeader
        title={t("requisitions.title")}
        description={t("requisitions.hint")}
        actions={
          holdsAnyGrant(ctx.grants, "purchasing.request") ? (
            <LinkButton href={`${base}/new`}>{t("requisitions.new")}</LinkButton>
          ) : null
        }
      />
      <nav aria-label={t("common.status")} className="mb-4 flex flex-wrap gap-2">
        <Link href={base} className={chip(!status)} aria-current={!status ? "page" : undefined}>
          {t("common.all")}
        </Link>
        {REQUISITION_STATUSES.map((s) => (
          <Link
            key={s}
            href={`${base}?status=${s}`}
            className={chip(status === s)}
            aria-current={status === s ? "page" : undefined}
          >
            {t(`requisitions.statuses.${s}`)}
          </Link>
        ))}
      </nav>
      {result.total === 0 ? (
        <EmptyState title={t("requisitions.empty")} />
      ) : (
        <Table label={t("requisitions.title")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("requisitions.warehouse")}</Th>
              <Th>{t("requisitions.lines")}</Th>
              <Th>{t("requisitions.neededBy")}</Th>
              <Th>{t("requisitions.submittedAt")}</Th>
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
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{r.warehouse.code}</span>
                  <span className="text-muted block text-xs">{r.warehouse.name}</span>
                </Td>
                <Td className="tabular-nums">{r._count.lines}</Td>
                <Td className="whitespace-nowrap">
                  {r.neededBy?.toISOString().slice(0, 10) ?? "—"}
                </Td>
                <Td className="whitespace-nowrap">
                  {r.submittedAt
                    ? format.dateTime(r.submittedAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: ctx.timeZone,
                      })
                    : "—"}
                </Td>
                <Td>
                  <RequisitionStatusBadge status={r.status} />
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
