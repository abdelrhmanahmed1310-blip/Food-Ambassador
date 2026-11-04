import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionFormScan } from "./scan-loaded";
import { Badge, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getLoad } from "@/modules/wms/loading";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { confirmLoadedAction } from "../../../inventory/loads/actions";

/** Scanning units onto a vehicle (ADR-104). */
export default async function ScanLoadPage({
  params,
}: PageProps<"/o/[orgSlug]/scan/loading/[loadId]">) {
  const { orgSlug, loadId } = await params;
  if (!isUuid(loadId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const l = await notFoundOnAppError(getLoad(ctx, loadId));
  const t = await getTranslations("scan");
  const units = l.pickLists.flatMap((p) => p.packUnits);
  return (
    <>
      <PageHeader title={`${l.number} — ${l.vehicleRef}`} description={t("loadHint")} />
      <div className="mx-auto max-w-xl space-y-4">
        <p className="text-2xl font-semibold" data-testid="load-progress">
          {t("loadedOf", { loaded: l.loadedCount, total: l.unitCount })}
        </p>
        {l.status === "OPEN" && l.canLoad ? (
          <ActionFormScan action={confirmLoadedAction.bind(null, orgSlug, l.id)} />
        ) : null}
        <ul className="space-y-1">
          {units.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2">
              <span className="ltr-value font-mono">{u.number}</span>
              {u.loadedAt ? (
                <Badge tone="success">{t("onVehicle")}</Badge>
              ) : (
                <Badge tone="muted">{t("waiting")}</Badge>
              )}
            </li>
          ))}
        </ul>
        <Link
          href={`/o/${orgSlug}/inventory/loads/${l.id}`}
          className="text-primary text-sm hover:underline"
        >
          {t("openLoad")}
        </Link>
      </div>
    </>
  );
}
