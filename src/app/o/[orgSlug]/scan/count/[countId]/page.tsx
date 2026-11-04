import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CountScanForm } from "./count-scan-form";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { countScanLines } from "@/modules/wms/scan";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName } from "@/server/inventory-view";
import { recordCountsAction } from "../../../inventory/actions";
import { ScanGetForm } from "../../scan-form";

/** Counting by scanning a product or lot, then entering what is there (ADR-104). */
export default async function ScanCountPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/scan/count/[countId]">) {
  const { orgSlug, countId } = await params;
  if (!isUuid(countId)) notFound();
  const sp = await searchParams;
  const code = typeof sp.code === "string" ? sp.code : "";
  const ctx = await requireTenant(orgSlug);
  const { count, lines } = await notFoundOnAppError(countScanLines(ctx, countId, code));
  const [t, locale] = await Promise.all([getTranslations("scan"), getLocale()]);
  const counted = count.lines.filter((l) => l.countedQuantity !== null).length;
  return (
    <>
      <PageHeader
        title={`${count.number} — ${count.warehouse.code}`}
        description={t("countHint")}
      />
      <div className="mx-auto max-w-xl space-y-4">
        <p className="text-lg font-semibold">
          {t("countedOf", { counted, total: count.lines.length })}
        </p>
        {count.status !== "OPEN" ? (
          <p className="text-sm">{t("countClosed")}</p>
        ) : (
          <>
            <ScanGetForm label={t("scanProduct")} />
            {code && lines.length === 0 ? <EmptyState title={t("notOnCount", { code })} /> : null}
            {lines.length > 0 ? (
              <CountScanForm
                action={recordCountsAction.bind(null, orgSlug, count.id)}
                lines={lines.map((l) => ({
                  id: l.id,
                  label: `${l.location?.code ? `${l.location.code} · ` : ""}${l.product.sku} — ${productName(l.product, locale)}${l.lot ? ` · ${l.lot.lotCode}` : ""}`,
                  unit: l.product.baseUom.code,
                  counted: l.countedQuantity?.toString() ?? "",
                }))}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
