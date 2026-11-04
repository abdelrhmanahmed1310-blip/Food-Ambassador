import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PickScanner } from "@/components/scan/pick-scanner";
import { PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { pickScanPlan } from "@/modules/wms/scan";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { confirmPickAction } from "../../../inventory/picking/actions";

/** Guided picking on a handheld (ADR-104). */
export default async function ScanPickPage({
  params,
}: PageProps<"/o/[orgSlug]/scan/picking/[pickListId]">) {
  const { orgSlug, pickListId } = await params;
  if (!isUuid(pickListId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const { list, steps } = await notFoundOnAppError(pickScanPlan(ctx, pickListId));
  const t = await getTranslations("scan");
  return (
    <>
      <PageHeader
        title={`${list.number} — ${list.salesOrder.customer.name}`}
        description={t("pickHint")}
      />
      <div className="mx-auto max-w-xl space-y-4">
        {list.status !== "PLANNED" || !list.canPick ? (
          <p className="text-sm">
            {t("notPickable")}{" "}
            <Link
              href={`/o/${orgSlug}/inventory/picking/${list.id}`}
              className="text-primary hover:underline"
            >
              {list.number}
            </Link>
          </p>
        ) : (
          <PickScanner steps={steps} action={confirmPickAction.bind(null, orgSlug, list.id)} />
        )}
      </div>
    </>
  );
}
