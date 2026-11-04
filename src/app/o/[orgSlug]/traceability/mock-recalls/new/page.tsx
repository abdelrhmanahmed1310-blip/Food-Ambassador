import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { StartMockRecallForm } from "@/components/traceability/mock-recall-forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { branchOptions } from "@/modules/foodsafety/service";
import { traceLot } from "@/modules/traceability/trace";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName } from "@/server/inventory-view";
import { startMockRecallAction } from "../actions";

export default async function NewMockRecallPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/traceability/mock-recalls/new">) {
  const { orgSlug } = await params;
  const { lotId } = await searchParams;
  if (typeof lotId !== "string" || !isUuid(lotId)) notFound();
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "recalls.manage")) notFound();
  const [t, locale, trace, branches] = await Promise.all([
    getTranslations(),
    getLocale(),
    notFoundOnAppError(traceLot(ctx, lotId)),
    branchOptions(ctx, "recalls.manage"),
  ]);
  return (
    <>
      <PageHeader
        title={t("mockRecalls.newTitle")}
        description={`${t("inventory.lot")} ${trace.lot.lotCode} · ${trace.lot.product.sku} — ${productName(trace.lot.product, locale)}`}
      />
      <Card>
        <p className="text-muted mb-4 text-sm">{t("mockRecalls.hint")}</p>
        <StartMockRecallForm
          action={startMockRecallAction.bind(null, orgSlug)}
          branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
          lotId={trace.lot.id}
        />
      </Card>
    </>
  );
}
