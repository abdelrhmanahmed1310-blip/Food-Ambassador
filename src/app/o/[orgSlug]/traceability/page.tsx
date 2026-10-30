import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { searchLots } from "@/modules/traceability/trace";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { productName } from "@/server/inventory-view";

export default async function TraceabilityPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/traceability">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "traceability.view")) notFound();
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const [t, locale, lots] = await Promise.all([getTranslations(), getLocale(), searchLots(ctx, q)]);
  return (
    <>
      <PageHeader title={t("trace.title")} description={t("trace.hint")} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3" role="search">
        <label className="text-sm">
          <span className="mb-1 block font-medium">{t("trace.searchLabel")}</span>
          <input
            name="q"
            defaultValue={q}
            className="border-border bg-surface rounded-md border px-3 py-2"
            dir="ltr"
          />
        </label>
        <button
          type="submit"
          className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
        >
          {t("common.search")}
        </button>
      </form>
      {q === "" ? null : lots.length === 0 ? (
        <EmptyState title={t("trace.noLots")} />
      ) : (
        <Table label={t("trace.title")}>
          <thead>
            <tr>
              <Th>{t("inventory.lot")}</Th>
              <Th>{t("inventory.product")}</Th>
              <Th>{t("inventory.expires")}</Th>
              <Th>{t("trace.firstReceived")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {lots.map((l) => (
              <tr key={l.id}>
                <Td>
                  <Link
                    href={`/o/${orgSlug}/traceability/lots/${l.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {l.lotCode}
                  </Link>
                </Td>
                <Td>
                  {productName(l.product, locale)}
                  <span className="ltr-value text-muted block font-mono text-xs">
                    {l.product.sku}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  {l.expiresOn?.toISOString().slice(0, 10) ?? "—"}
                </Td>
                <Td className="whitespace-nowrap">
                  {l.firstReceivedAt.toISOString().slice(0, 10)}
                </Td>
                <Td>{l.recallHold ? <Badge tone="danger">{t("trace.recallHold")}</Badge> : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
