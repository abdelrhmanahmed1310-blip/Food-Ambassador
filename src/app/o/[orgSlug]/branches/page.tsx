import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ListFilters } from "@/components/ui/list-filters";
import { Pagination } from "@/components/ui/pagination";
import {
  Badge,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { pageSchema } from "@/modules/shared/schemas";
import { listBranches } from "@/modules/sites/branches";
import { listStatusSchema } from "@/modules/sites/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function BranchesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/branches">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = listStatusSchema.parse(sp.status);
  const page = pageSchema.parse(sp.page);
  const [t, tc, result] = await Promise.all([
    getTranslations("branches"),
    getTranslations("common"),
    listBranches(ctx, { q, status, page }),
  ]);
  const canCreate = hasPermission(ctx.grants, "branches.manage");
  const base = `/o/${orgSlug}/branches`;

  return (
    <>
      <PageHeader
        title={t("title")}
        actions={canCreate ? <LinkButton href={`${base}/new`}>{t("new")}</LinkButton> : undefined}
      />
      <ListFilters q={q} status={status} />
      {result.total === 0 && !q && status === "active" ? (
        <EmptyState
          title={t("empty")}
          hint={t("emptyHint")}
          action={canCreate ? <LinkButton href={`${base}/new`}>{t("new")}</LinkButton> : undefined}
        />
      ) : result.items.length === 0 ? (
        <EmptyState title={tc("noResults")} />
      ) : (
        <Table label={t("title")}>
          <thead>
            <tr>
              <Th>{t("code")}</Th>
              <Th>{t("name")}</Th>
              <Th>{t("type")}</Th>
              <Th>{t("activeWarehouses")}</Th>
              <Th>{tc("status")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((b) => (
              <tr key={b.id}>
                <Td>
                  <span className="ltr-value font-mono text-xs">{b.code}</span>
                </Td>
                <Td>
                  <Link
                    href={`${base}/${b.id}`}
                    className="text-primary font-medium hover:underline"
                  >
                    {b.name}
                  </Link>
                </Td>
                <Td>{t(`types.${b.type}`)}</Td>
                <Td className="tabular-nums">{b._count.warehouses}</Td>
                <Td>
                  {b.archivedAt ? (
                    <Badge tone="muted">{tc("archived")}</Badge>
                  ) : (
                    <Badge tone="success">{tc("active")}</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={base}
        params={{ q, status: status === "active" ? undefined : status }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
