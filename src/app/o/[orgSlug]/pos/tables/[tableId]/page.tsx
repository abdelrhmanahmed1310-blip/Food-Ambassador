import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { OpenTabForm } from "@/components/pos/forms";
import { Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { floorPlan } from "@/modules/pos/tables";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { openTabAction } from "../../tables-actions";

/** Seat guests at a free table. */
export default async function TablePage({
  params,
}: PageProps<"/o/[orgSlug]/pos/tables/[tableId]">) {
  const { orgSlug, tableId } = await params;
  if (!isUuid(tableId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const [t, plan] = await Promise.all([getTranslations(), floorPlan(ctx)]);
  const floor = plan.floors.find((f) => f.tables.some((x) => x.id === tableId));
  const table = floor?.tables.find((x) => x.id === tableId);
  if (!floor || !table || !floor.can.serve) notFound();
  if (table.tab) redirect(`/o/${orgSlug}/pos/tabs/${table.tab.id}`);
  return (
    <>
      <PageHeader
        title={t("pos.tableTitle", { code: table.code })}
        description={`${floor.branch.name} · ${floor.name} · ${t("pos.seatsCount", { count: table.seats })}`}
        actions={
          <LinkButton href={`/o/${orgSlug}/pos/floor`} variant="secondary">
            {t("pos.floorPlan")}
          </LinkButton>
        }
      />
      <Card title={t("pos.openCheck")}>
        <OpenTabForm
          action={openTabAction.bind(null, orgSlug)}
          tableId={table.id}
          seats={table.seats}
        />
      </Card>
    </>
  );
}
