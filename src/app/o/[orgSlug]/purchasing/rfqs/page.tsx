import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { RfqStatusBadge } from "@/components/procurement/badges";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listRfqs } from "@/modules/procurement/rfqs";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const STATUSES = ["DRAFT", "SENT", "AWARDED", "CANCELLED"] as const;

export default async function RfqsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/rfqs">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.view")) notFound();
  const status = STATUSES.find((s) => s === sp.status);
  const page = pageSchema.parse(sp.page);
  const [t, format, result] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listRfqs(ctx, { status, page }),
  ]);
  const base = `/o/${orgSlug}/purchasing/rfqs`;
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border hover:bg-surface-muted"
    }`;
  const date = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" }) : "—";
  return (
    <>
      <PageHeader
        title={t("rfqs.title")}
        description={t("rfqs.hint")}
        actions={
          holdsAnyGrant(ctx.grants, "purchasing.manage") ? (
            <LinkButton href={`${base}/new`}>{t("rfqs.new")}</LinkButton>
          ) : null
        }
      />
      <nav aria-label={t("common.status")} className="mb-4 flex flex-wrap gap-2">
        <Link href={base} className={chip(!status)} aria-current={!status ? "page" : undefined}>
          {t("common.all")}
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`${base}?status=${s}`}
            className={chip(status === s)}
            aria-current={status === s ? "page" : undefined}
          >
            {t(`rfqs.statuses.${s}`)}
          </Link>
        ))}
      </nav>
      {result.total === 0 ? (
        <EmptyState title={t("rfqs.empty")} />
      ) : (
        <Table label={t("rfqs.title")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("rfqs.titleField")}</Th>
              <Th>{t("rfqs.deliverTo")}</Th>
              <Th>{t("rfqs.respondBy")}</Th>
              <Th>{t("rfqs.quotationsCount")}</Th>
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
                <Td>{r.title}</Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{r.warehouse.code}</span>
                  <span className="text-muted block text-xs">{r.warehouse.name}</span>
                </Td>
                <Td className="whitespace-nowrap">{date(r.respondBy)}</Td>
                <Td className="tabular-nums">
                  {r._count.quotations} / {r._count.suppliers}
                </Td>
                <Td>
                  <RfqStatusBadge status={r.status} />
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
