import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { WaveForm } from "@/components/wms/picking-forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listWarehouseOptions } from "@/modules/sites/warehouses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { listPickLists, ordersToPick } from "@/modules/wms/picking";
import { createWaveAction } from "./actions";
import { PickStatusBadge } from "./badge";

/** Open pick lists, and planning a wave of confirmed orders per warehouse (ADR-102). */
export default async function PickingPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/picking">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const all = sp.status === "all";
  const [t, lists, warehouses] = await Promise.all([
    getTranslations(),
    listPickLists(ctx, { status: all ? "all" : "open" }),
    listWarehouseOptions(ctx),
  ]);
  const warehouse = warehouses.find((w) => w.id === sp.warehouse) ?? null;
  const canPlan = holdsAnyGrant(ctx.grants, "inventory.transfer");
  const orders = warehouse && canPlan ? await ordersToPick(ctx, warehouse.id) : [];
  const base = `/o/${orgSlug}/inventory/picking`;
  return (
    <>
      <PageHeader title={t("picking.title")} description={t("picking.hint")} />
      <div className="space-y-6">
        <p className="text-sm">
          <Link href={all ? base : `${base}?status=all`} className="text-primary hover:underline">
            {all ? t("picking.showOpen") : t("picking.showAll")}
          </Link>
        </p>
        {lists.length === 0 ? (
          <EmptyState title={t("picking.empty")} />
        ) : (
          <Table label={t("picking.title")}>
            <thead>
              <tr>
                <Th>{t("picking.number")}</Th>
                <Th>{t("picking.order")}</Th>
                <Th>{t("picking.warehouse")}</Th>
                <Th>{t("picking.wave")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {lists.map((l) => (
                <tr key={l.id}>
                  <Td>
                    <Link
                      href={`${base}/${l.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {l.number}
                    </Link>
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{l.salesOrder.number}</span>
                    <span className="text-muted block text-xs">
                      {l.salesOrder.customer.code} — {l.salesOrder.customer.name}
                    </span>
                  </Td>
                  <Td className="ltr-value font-mono text-xs">{l.warehouse.code}</Td>
                  <Td>
                    {l.wave ? (
                      <Link
                        href={`${base}/waves/${l.wave.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {l.wave.number}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    <PickStatusBadge status={l.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {canPlan ? (
          <Card title={t("picking.waveTitle")}>
            <p className="text-muted mb-3 text-sm">{t("picking.waveHint")}</p>
            <nav className="mb-4 flex flex-wrap gap-3 text-sm" aria-label={t("picking.warehouse")}>
              {warehouses.map((w) =>
                w.id === warehouse?.id ? (
                  <span key={w.id} className="font-medium" aria-current="page">
                    {w.code} — {w.name}
                  </span>
                ) : (
                  <Link
                    key={w.id}
                    href={`${base}?warehouse=${w.id}`}
                    className="text-primary hover:underline"
                  >
                    {w.code} — {w.name}
                  </Link>
                ),
              )}
            </nav>
            {!warehouse ? null : orders.length === 0 ? (
              <p className="text-muted text-sm">{t("picking.noOrders")}</p>
            ) : (
              <WaveForm
                action={createWaveAction.bind(null, orgSlug, warehouse.id)}
                orders={orders.map((o) => ({
                  value: o.id,
                  label: `${o.number} · ${o.customer.code} ${o.customer.name}${o.requestedOn ? ` · ${o.requestedOn.toISOString().slice(0, 10)}` : ""}`,
                }))}
              />
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
