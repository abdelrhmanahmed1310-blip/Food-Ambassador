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
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { pageSchema } from "@/modules/shared/schemas";
import { listBranchOptions } from "@/modules/sites/branches";
import { listStatusSchema } from "@/modules/sites/schemas";
import { listWarehouses } from "@/modules/sites/warehouses";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function WarehousesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/warehouses">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const branchId = typeof sp.branchId === "string" && isUuid(sp.branchId) ? sp.branchId : undefined;
  const status = listStatusSchema.parse(sp.status);
  const page = pageSchema.parse(sp.page);
  const [t, tc, result, branches] = await Promise.all([
    getTranslations("warehouses"),
    getTranslations("common"),
    listWarehouses(ctx, { q, status, branchId, page }),
    listBranchOptions(ctx),
  ]);
  const canCreate = holdsAnyGrant(ctx.grants, "warehouses.manage");
  const base = `/o/${orgSlug}/warehouses`;
  const newButton = canCreate ? (
    <LinkButton href={`${base}/new`}>{t("new")}</LinkButton>
  ) : undefined;

  return (
    <>
      <PageHeader title={t("title")} actions={newButton} />
      <ListFilters
        q={q}
        status={status}
        extra={{
          name: "branchId",
          label: t("allBranches"),
          value: branchId,
          options: branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
        }}
      />
      {result.total === 0 && !q && !branchId && status === "active" ? (
        <EmptyState title={t("empty")} hint={t("emptyHint")} action={newButton} />
      ) : result.items.length === 0 ? (
        <EmptyState title={tc("noResults")} />
      ) : (
        <Table label={t("title")}>
          <thead>
            <tr>
              <Th>{t("code")}</Th>
              <Th>{t("name")}</Th>
              <Th>{t("branch")}</Th>
              <Th>{t("type")}</Th>
              <Th>{t("locations")}</Th>
              <Th>{tc("status")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((w) => (
              <tr key={w.id}>
                <Td>
                  <span className="ltr-value font-mono text-xs">{w.code}</span>
                </Td>
                <Td>
                  <Link
                    href={`${base}/${w.id}`}
                    className="text-primary font-medium hover:underline"
                  >
                    {w.name}
                  </Link>
                </Td>
                <Td>{w.branch.name}</Td>
                <Td>{t(`types.${w.type}`)}</Td>
                <Td className="tabular-nums">{w._count.locations}</Td>
                <Td>
                  {w.archivedAt ? (
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
        params={{ q, branchId, status: status === "active" ? undefined : status }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
