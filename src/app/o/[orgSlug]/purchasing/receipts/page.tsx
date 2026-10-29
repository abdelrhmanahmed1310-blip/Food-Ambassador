import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ReceiptStatusBadge } from "@/components/procurement/badges";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listReceipts } from "@/modules/procurement/receipts";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function ReceiptsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/receipts">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.view")) notFound();
  const supplierId =
    typeof sp.supplierId === "string" && isUuid(sp.supplierId) ? sp.supplierId : undefined;
  const page = pageSchema.parse(sp.page);
  const [t, locale, format, result] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    listReceipts(ctx, { supplierId, page }),
  ]);
  const base = `/o/${orgSlug}/purchasing`;
  return (
    <>
      <PageHeader title={t("purchasing.receiptsListTitle")} />
      {result.total === 0 ? (
        <EmptyState title={t("purchasing.noReceipts")} />
      ) : (
        <Table label={t("purchasing.receiptsListTitle")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("purchasing.receivedAt")}</Th>
              <Th>{t("purchasing.supplier")}</Th>
              <Th>{t("purchasing.ordersTitle")}</Th>
              <Th>{t("common.warehouse")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link
                    href={`${base}/receipts/${r.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {r.number}
                  </Link>
                  {r.deliveryNoteRef ? (
                    <span className="ltr-value text-muted block text-xs">{r.deliveryNoteRef}</span>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap">
                  {format.dateTime(r.receivedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: ctx.timeZone,
                  })}
                </Td>
                <Td>{(locale === "ar" && r.supplier.nameAr) || r.supplier.name}</Td>
                <Td>
                  <Link
                    href={`${base}/orders/${r.purchaseOrder.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {r.purchaseOrder.number}
                  </Link>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{r.warehouse.code}</span>
                </Td>
                <Td>
                  <ReceiptStatusBadge status={r.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={`${base}/receipts`}
        params={{ supplierId }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
