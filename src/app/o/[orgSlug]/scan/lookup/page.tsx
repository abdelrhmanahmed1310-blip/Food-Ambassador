import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { resolveScan, type ScanMatch } from "@/modules/wms/scan";
import { ScanGetForm } from "../scan-form";

/** Scan anything: unit, list, load, location, product or lot (ADR-104). */
export default async function LookupPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/scan/lookup">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const code = typeof sp.code === "string" ? sp.code : "";
  const [t, result] = await Promise.all([
    getTranslations("scan"),
    code ? resolveScan(ctx, code) : Promise.resolve(null),
  ]);
  const base = `/o/${orgSlug}`;
  const href = (m: ScanMatch) =>
    ({
      PACK_UNIT:
        m.kind === "PACK_UNIT" && m.loadId
          ? `${base}/scan/loading/${m.loadId}`
          : `${base}/inventory/picking/${"pickListId" in m ? m.pickListId : ""}`,
      PICK_LIST: `${base}/inventory/picking/${m.id}`,
      LOAD: `${base}/inventory/loads/${m.id}`,
      LOCATION: `${base}/warehouses/${"warehouseId" in m ? m.warehouseId : ""}`,
      PRODUCT: `${base}/catalog/products/${m.id}`,
      LOT: `${base}/traceability/lots/${m.id}`,
    })[m.kind];
  return (
    <>
      <PageHeader title={t("lookup")} description={t("lookupHint")} />
      <div className="mx-auto max-w-xl space-y-6">
        <ScanGetForm label={t("code")} />
        {result === null ? null : result.matches.length === 0 ? (
          <EmptyState title={t("nothingFound", { code: result.code })} />
        ) : (
          <ul className="space-y-2">
            {result.matches.map((m) => (
              <li key={`${m.kind}-${m.id}`}>
                <Link
                  href={href(m)}
                  className="border-border bg-surface hover:bg-surface-muted block rounded-lg border px-4 py-3"
                >
                  <span className="text-muted block text-xs">{t(`kinds.${m.kind}`)}</span>
                  <span className="ltr-value font-mono">{m.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
