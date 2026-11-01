import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { FloorForm, TableForm } from "@/components/pos/forms";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { registerFormOptions } from "@/modules/pos/service";
import { floorPlan } from "@/modules/pos/tables";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createFloorAction, createTableAction, setTableArchivedAction } from "../tables-actions";

/** Set up dining areas and their tables (pos.manage). */
export default async function FloorsPage({ params }: PageProps<"/o/[orgSlug]/pos/floors">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "pos.manage")) notFound();
  const [t, plan, branches] = await Promise.all([
    getTranslations(),
    floorPlan(ctx),
    registerFormOptions(ctx),
  ]);
  return (
    <>
      <PageHeader
        title={t("pos.floorsTitle")}
        description={t("pos.floorsIntro")}
        actions={
          <LinkButton href={`/o/${orgSlug}/pos/floor`} variant="secondary">
            {t("pos.floorPlan")}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        {plan.floors.length === 0 ? <EmptyState title={t("pos.noFloors")} /> : null}
        {plan.floors.map((f) => (
          <Card
            key={f.id}
            title={`${f.branch.code} · ${f.name} — ${t("pos.kitchenFrom", { warehouse: f.warehouse.name })}`}
          >
            <div className="space-y-4" data-testid={`floor-${f.name}`}>
              {f.tables.length === 0 ? (
                <p className="text-muted text-sm">{t("pos.noTables")}</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {f.tables.map((tb) => (
                    <li
                      key={tb.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span>
                        <span className="ltr-value font-mono">{tb.code}</span> ·{" "}
                        {t("pos.seatsCount", { count: tb.seats })} ·{" "}
                        <span className="text-muted">
                          {t("pos.gridAt", { x: tb.gridX, y: tb.gridY })}
                        </span>
                      </span>
                      <ConfirmActionButton
                        action={setTableArchivedAction.bind(null, orgSlug, tb.id, true)}
                        label={t("pos.removeTable")}
                        variant="secondary"
                      />
                    </li>
                  ))}
                </ul>
              )}
              <TableForm action={createTableAction.bind(null, orgSlug, f.id)} />
            </div>
          </Card>
        ))}
        <Card title={t("pos.addFloor")}>
          {branches.length === 0 ? (
            <p className="text-muted text-sm">{t("pos.needBranch")}</p>
          ) : (
            <FloorForm
              action={createFloorAction.bind(null, orgSlug)}
              branches={branches.map((b) => ({
                id: b.id,
                label: `${b.code} — ${b.name}`,
                warehouses: b.warehouses.map((w) => ({
                  value: w.id,
                  label: `${w.code} — ${w.name}`,
                })),
              }))}
            />
          )}
        </Card>
      </div>
    </>
  );
}
