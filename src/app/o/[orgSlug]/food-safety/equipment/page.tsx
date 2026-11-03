import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DueBadge, EquipmentStatusBadge } from "@/components/foodsafety/equipment-badges";
import { EquipmentForm } from "@/components/foodsafety/equipment-forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listEquipment } from "@/modules/foodsafety/equipment";
import { branchOptions, listCheckpoints } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createEquipmentAction } from "./actions";

export default async function EquipmentPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/food-safety/equipment">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const manage = holdsAnyGrant(ctx.grants, "foodsafety.manage");
  const includeRetired = sp.retired === "1";
  const [t, items, branches, checkpoints] = await Promise.all([
    getTranslations(),
    listEquipment(ctx, { includeRetired }),
    manage ? branchOptions(ctx, "foodsafety.manage") : Promise.resolve([]),
    manage ? listCheckpoints(ctx) : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader title={t("equipment.title")} description={t("equipment.hint")} />
      <div className="space-y-6">
        <p className="text-sm">
          <Link
            href={`/o/${orgSlug}/food-safety/equipment${includeRetired ? "" : "?retired=1"}`}
            className="text-primary hover:underline"
          >
            {includeRetired ? t("equipment.hideRetired") : t("equipment.showRetired")}
          </Link>
        </p>
        {items.length === 0 ? (
          <EmptyState title={t("equipment.empty")} />
        ) : (
          <Table label={t("equipment.title")}>
            <thead>
              <tr>
                <Th>{t("equipment.code")}</Th>
                <Th>{t("equipment.name")}</Th>
                <Th>{t("equipment.calibrationDue")}</Th>
                <Th>{t("equipment.maintenanceDue")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/food-safety/equipment/${e.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {e.code}
                    </Link>
                    <span className="ltr-value text-muted block font-mono text-xs">
                      {e.branch.code}
                    </span>
                  </Td>
                  <Td>
                    {e.name}
                    <span className="text-muted block text-xs">
                      {t(`equipment.types.${e.type}`)}
                    </span>
                  </Td>
                  <Td>
                    <DueBadge state={e.calibrationState} date={e.calibrationDue} />
                  </Td>
                  <Td>
                    <DueBadge state={e.maintenanceState} date={e.maintenanceDue} />
                  </Td>
                  <Td>
                    <EquipmentStatusBadge status={e.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage && branches.length > 0 ? (
          <Card title={t("equipment.registerTitle")}>
            <EquipmentForm
              action={createEquipmentAction.bind(null, orgSlug)}
              branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
              checkpoints={checkpoints
                .filter((c) => !c.archivedAt)
                .map((c) => ({ value: c.id, label: `${c.branch.code} · ${c.code} — ${c.name}` }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
