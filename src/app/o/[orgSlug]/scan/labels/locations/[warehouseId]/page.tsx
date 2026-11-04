import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BarcodeSvg } from "@/components/scan/barcode-svg";
import { PrintButton } from "@/components/ui/print-button";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getWarehouse } from "@/modules/sites/warehouses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";

/** Printable shelf labels for a warehouse's locations (ADR-104). */
export default async function LocationLabelsPage({
  params,
}: PageProps<"/o/[orgSlug]/scan/labels/locations/[warehouseId]">) {
  const { orgSlug, warehouseId } = await params;
  if (!isUuid(warehouseId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const w = await notFoundOnAppError(getWarehouse(ctx, warehouseId));
  const t = await getTranslations();
  const locations = w.locations.filter((l) => !l.archivedAt);
  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title={`${t("scan.locationLabels")} — ${w.code}`}
          actions={<PrintButton label={t("scan.print")} />}
        />
      </div>
      {locations.length === 0 ? (
        <EmptyState title={t("scan.noLocations")} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3 print:grid-cols-3">
          {locations.map((l) => (
            <div
              key={l.id}
              className="break-inside-avoid rounded border border-black bg-white p-3 text-black"
            >
              <BarcodeSvg value={l.code} />
              <p className="ltr-value font-mono text-xl font-bold">{l.code}</p>
              <p className="text-sm">{l.name}</p>
              <p className="text-xs">
                {t(`warehouses.uses.${l.zone}`)} · {t(`warehouses.zones.${l.temperatureZone}`)}
              </p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
