import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { OpenTabForm } from "@/components/pos/forms";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { floorPlan } from "@/modules/pos/tables";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { openTabAction } from "../tables-actions";

/** Minutes since a check was opened (server time of this render). */
function minutes(since: Date): number {
  return Math.max(0, Math.round((Date.now() - since.getTime()) / 60_000));
}

/** The floor plan: free tables, open checks and how long they have been open. */
export default async function FloorPlanPage({ params }: PageProps<"/o/[orgSlug]/pos/floor">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const manage = hasPermission(ctx.grants, "pos.manage");
  if (
    !manage &&
    !(["pos.tables", "pos.sell", "pos.view"] as const).some((p) => holdsAnyGrant(ctx.grants, p))
  )
    notFound();
  const [t, format, plan] = await Promise.all([getTranslations(), getFormatter(), floorPlan(ctx)]);
  const branches = [...new Map(plan.floors.map((f) => [f.branchId, f])).values()];
  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        title={t("pos.floorPlan")}
        description={t("pos.floorPlanIntro")}
        actions={
          manage ? (
            <LinkButton href={`/o/${orgSlug}/pos/floors`} variant="secondary">
              {t("pos.floorsTitle")}
            </LinkButton>
          ) : null
        }
      />
      {plan.floors.length === 0 ? (
        <EmptyState title={t("pos.noFloors")} hint={manage ? t("pos.noFloorsHint") : undefined} />
      ) : null}
      <div className="space-y-6">
        {plan.floors.map((f) => {
          const cols = Math.max(4, ...f.tables.map((x) => x.gridX + 1));
          return (
            <Card key={f.id} title={`${f.branch.name} · ${f.name}`}>
              <div
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(4.5rem, 1fr))` }}
                data-testid={`plan-${f.name}`}
              >
                {f.tables.map((tb) => {
                  const style = { gridColumnStart: tb.gridX + 1, gridRowStart: tb.gridY + 1 };
                  const common =
                    "flex min-h-20 flex-col justify-between rounded-lg border p-2 text-start text-sm";
                  return tb.tab ? (
                    <Link
                      key={tb.id}
                      href={`/o/${orgSlug}/pos/tabs/${tb.tab.id}`}
                      style={style}
                      className={`${common} border-primary bg-primary/10`}
                      aria-label={t("pos.tableBusy", { code: tb.code, number: tb.tab.number })}
                    >
                      <span className="ltr-value font-semibold">{tb.code}</span>
                      <span className="text-xs">
                        {t("pos.guestsCount", { count: tb.tab.guests })} ·{" "}
                        {t("pos.minutes", { count: minutes(tb.tab.openedAt) })}
                      </span>
                      {tb.tab.pending > 0 ? (
                        <span className="bg-warning-surface rounded px-1 text-xs">
                          {t("pos.unsentCount", { count: tb.tab.pending })}
                        </span>
                      ) : null}
                    </Link>
                  ) : f.can.serve ? (
                    <Link
                      key={tb.id}
                      href={`/o/${orgSlug}/pos/tables/${tb.id}`}
                      style={style}
                      className={`${common} border-border bg-surface hover:border-primary`}
                      aria-label={t("pos.tableFree", { code: tb.code })}
                    >
                      <span className="ltr-value font-semibold">{tb.code}</span>
                      <span className="text-muted text-xs">
                        {t("pos.seatsCount", { count: tb.seats })}
                      </span>
                    </Link>
                  ) : (
                    <div key={tb.id} style={style} className={`${common} border-border bg-surface`}>
                      <span className="ltr-value font-semibold">{tb.code}</span>
                      <span className="text-muted text-xs">{t("pos.free")}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
        {plan.floors.length > 0 ? (
          <Card title={t("pos.namedChecks")}>
            <div className="space-y-4">
              {plan.barTabs.length === 0 ? (
                <p className="text-muted text-sm">{t("pos.noNamedChecks")}</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {plan.barTabs.map((b) => (
                    <li key={b.id} className="py-2">
                      <Link
                        href={`/o/${orgSlug}/pos/tabs/${b.id}`}
                        className="text-primary hover:underline"
                      >
                        <bdi>{b.label}</bdi> · <span className="ltr-value">{b.number}</span>
                      </Link>{" "}
                      <span className="text-muted">
                        {format.dateTime(b.openedAt, {
                          timeStyle: "short",
                          timeZone: ctx.timeZone,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {branches
                .filter((f) => f.can.serve)
                .map((f) => (
                  <div key={f.branchId}>
                    {branches.length > 1 ? (
                      <p className="mb-2 text-sm font-medium">{f.branch.name}</p>
                    ) : null}
                    <OpenTabForm action={openTabAction.bind(null, orgSlug)} branchId={f.branchId} />
                  </div>
                ))}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
