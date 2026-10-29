import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Pagination } from "@/components/ui/pagination";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listDocuments } from "@/modules/inventory/queries";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function DocumentsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/documents">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const page = pageSchema.parse((await searchParams).page);
  const [t, format, result] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listDocuments(ctx, { page }),
  ]);
  return (
    <>
      <PageHeader title={t("inventory.documentsTitle")} />
      {result.items.length === 0 ? (
        <EmptyState title={t("inventory.noDocuments")} />
      ) : (
        <Table label={t("inventory.documentsTitle")}>
          <thead>
            <tr>
              <Th>{t("inventory.document")}</Th>
              <Th>{t("inventory.documentType")}</Th>
              <Th>{t("common.warehouse")}</Th>
              <Th>{t("inventory.entries")}</Th>
              <Th>{t("common.date")}</Th>
              <Th>{t("common.by")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((d) => (
              <tr key={d.id}>
                <Td>
                  <Link
                    href={`/o/${orgSlug}/inventory/documents/${d.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {d.number}
                  </Link>
                  {d.reversedBy ? (
                    <span className="mt-1 block">
                      <Badge tone="muted">
                        {t("inventory.reversedBy", { number: d.reversedBy.number })}
                      </Badge>
                    </span>
                  ) : null}
                </Td>
                <Td>{t(`inventory.documentTypes.${d.type}`)}</Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">
                    {d.warehouse.code}
                    {d.destination && d.destination.code !== d.warehouse.code
                      ? ` → ${d.destination.code}`
                      : ""}
                  </span>
                </Td>
                <Td className="tabular-nums">{d._count.entries}</Td>
                <Td className="whitespace-nowrap">
                  {format.dateTime(d.postedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: ctx.timeZone,
                  })}
                </Td>
                <Td>{d.postedByName}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={`/o/${orgSlug}/inventory/documents`}
        params={{}}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
