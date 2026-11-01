import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { RouteForm, StationForm } from "@/components/pos/forms";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { kitchenSetup } from "@/modules/pos/kitchen";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createStationAction, removeRouteAction, setRouteAction } from "../../kitchen-actions";

/** Stations and what each prepares (pos.manage). */
export default async function KitchenSetupPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/kitchen/setup">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "pos.manage")) notFound();
  const [t, setup] = await Promise.all([getTranslations(), kitchenSetup(ctx)]);
  const categories = setup.categories.map((c) => ({ value: c.id, label: c.name }));
  const items = setup.items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }));
  return (
    <>
      <PageHeader
        title={t("pos.kitchenSetup")}
        description={t("pos.kitchenSetupIntro")}
        actions={
          <LinkButton href={`/o/${orgSlug}/pos/kitchen`} variant="secondary">
            {t("pos.kitchenScreens")}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        {setup.stations.length === 0 ? <EmptyState title={t("pos.noStations")} /> : null}
        {setup.stations.map((s) => (
          <Card key={s.id} title={`${s.branch.code} · ${s.name}`}>
            <div className="space-y-4" data-testid={`station-${s.code}`}>
              <p className="text-sm">
                {t("pos.targetIs", { minutes: s.targetMinutes })}{" "}
                {s.isDefault ? <Badge tone="success">{t("pos.defaultStation")}</Badge> : null}
              </p>
              {s.routes.length === 0 ? (
                <p className="text-muted text-sm">{t("pos.noRoutes")}</p>
              ) : (
                <ul className="divide-border divide-y text-sm">
                  {s.routes.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                      <span>
                        {r.category
                          ? t("pos.routeCategory", { name: r.category.name })
                          : t("pos.routeItem", {
                              name: `${r.menuItem?.code} — ${r.menuItem?.name}`,
                            })}
                      </span>
                      <ConfirmActionButton
                        action={removeRouteAction.bind(null, orgSlug, r.id)}
                        label={t("pos.removeRoute")}
                        variant="secondary"
                      />
                    </li>
                  ))}
                </ul>
              )}
              <RouteForm
                action={setRouteAction.bind(null, orgSlug, s.id)}
                categories={categories}
                items={items}
              />
            </div>
          </Card>
        ))}
        <Card title={t("pos.addStation")}>
          <StationForm
            action={createStationAction.bind(null, orgSlug)}
            branches={setup.branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
          />
        </Card>
      </div>
    </>
  );
}
