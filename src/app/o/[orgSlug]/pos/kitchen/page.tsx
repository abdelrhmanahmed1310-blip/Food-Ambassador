import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { listStations } from "@/modules/pos/kitchen";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** Choose a kitchen station's screen. */
export default async function KitchenPage({ params }: PageProps<"/o/[orgSlug]/pos/kitchen">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const manage = hasPermission(ctx.grants, "pos.manage");
  if (!manage && !holdsAnyGrant(ctx.grants, "pos.kitchen")) notFound();
  const [t, stations] = await Promise.all([getTranslations(), listStations(ctx)]);
  return (
    <>
      <PageHeader
        title={t("pos.kitchenScreens")}
        description={t("pos.kitchenIntro")}
        actions={
          manage ? (
            <LinkButton href={`/o/${orgSlug}/pos/kitchen/setup`} variant="secondary">
              {t("pos.kitchenSetup")}
            </LinkButton>
          ) : null
        }
      />
      {stations.length === 0 ? (
        <EmptyState
          title={t("pos.noStations")}
          hint={manage ? t("pos.noStationsHint") : undefined}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stations.map((s) => (
            <li key={s.id}>
              <Link
                href={`/o/${orgSlug}/pos/kitchen/${s.id}`}
                className="border-border bg-surface hover:border-primary flex min-h-24 flex-col justify-between rounded-lg border p-4"
              >
                <span className="text-lg font-semibold">{s.name}</span>
                <span className="text-muted text-sm">
                  {s.branch.name} · {t("pos.openTickets", { count: s._count.tickets })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
