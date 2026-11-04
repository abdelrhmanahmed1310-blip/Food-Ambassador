import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BarcodeSvg } from "@/components/scan/barcode-svg";
import { PrintButton } from "@/components/ui/print-button";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getPickList } from "@/modules/wms/picking";
import { notFoundOnAppError } from "@/server/actions/not-found";

/** Printable labels for the pack units of one order (ADR-104). */
export default async function UnitLabelsPage({
  params,
}: PageProps<"/o/[orgSlug]/scan/labels/pick-list/[pickListId]">) {
  const { orgSlug, pickListId } = await params;
  if (!isUuid(pickListId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const p = await notFoundOnAppError(getPickList(ctx, pickListId));
  const t = await getTranslations();
  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title={`${t("scan.unitLabels")} — ${p.number}`}
          actions={<PrintButton label={t("scan.print")} />}
        />
      </div>
      {p.packUnits.length === 0 ? (
        <EmptyState title={t("loads.notPacked")} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
          {p.packUnits.map((u, i) => (
            <div
              key={u.id}
              className="break-inside-avoid rounded border border-black bg-white p-3 text-black"
            >
              <p className="text-xs">{p.warehouse.code}</p>
              <p className="text-lg font-bold">{p.salesOrder.customer.name}</p>
              <p className="ltr-value font-mono text-sm">{p.salesOrder.number}</p>
              <BarcodeSvg value={u.number} />
              <p className="ltr-value font-mono text-base font-semibold">{u.number}</p>
              <p className="text-xs">
                {t(`loads.unitTypes.${u.type}`)} ·{" "}
                {t("scan.unitOf", { n: i + 1, total: p.packUnits.length })}
              </p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
