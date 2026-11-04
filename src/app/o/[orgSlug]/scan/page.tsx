import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listCounts } from "@/modules/inventory/counts";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { listLoads } from "@/modules/wms/loading";
import { listPickLists } from "@/modules/wms/picking";

/** The handheld start screen: what is waiting to be scanned (ADR-104). */
export default async function ScanHome({ params }: PageProps<"/o/[orgSlug]/scan">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const [t, lists, loads, counts] = await Promise.all([
    getTranslations("scan"),
    listPickLists(ctx),
    listLoads(ctx),
    listCounts(ctx),
  ]);
  const base = `/o/${orgSlug}/scan`;
  const big =
    "border-border bg-surface block rounded-lg border px-4 py-3 text-lg hover:bg-surface-muted";
  const planned = lists.filter((l) => l.status === "PLANNED");
  const open = counts.items.filter((c) => c.status === "OPEN");
  return (
    <>
      <PageHeader title={t("title")} description={t("hint")} />
      <div className="mx-auto max-w-xl space-y-6">
        <Link href={`${base}/lookup`} className={big}>
          {t("lookup")}
        </Link>
        <Card title={t("picking")}>
          {planned.length === 0 ? (
            <p className="text-muted text-sm">{t("nothingToPick")}</p>
          ) : (
            <div className="space-y-2">
              {planned.map((l) => (
                <Link key={l.id} href={`${base}/picking/${l.id}`} className={big}>
                  <span className="ltr-value font-mono">{l.number}</span> ·{" "}
                  {l.salesOrder.customer.name}
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card title={t("loading")}>
          {loads.length === 0 ? (
            <p className="text-muted text-sm">{t("nothingToLoad")}</p>
          ) : (
            <div className="space-y-2">
              {loads.map((l) => (
                <Link key={l.id} href={`${base}/loading/${l.id}`} className={big}>
                  <span className="ltr-value font-mono">{l.number}</span> · {l.vehicleRef}
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card title={t("counting")}>
          {open.length === 0 ? (
            <p className="text-muted text-sm">{t("nothingToCount")}</p>
          ) : (
            <div className="space-y-2">
              {open.map((c) => (
                <Link key={c.id} href={`${base}/count/${c.id}`} className={big}>
                  <span className="ltr-value font-mono">{c.number}</span> · {c.warehouse.code}
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
