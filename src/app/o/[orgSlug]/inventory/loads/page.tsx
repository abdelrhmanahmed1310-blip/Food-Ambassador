import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { LoadForm } from "@/components/wms/loading-forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listWarehouseOptions } from "@/modules/sites/warehouses";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { listLoads } from "@/modules/wms/loading";
import { createLoadAction } from "./actions";

const LOAD_TONES = { OPEN: "warning", DISPATCHED: "success", CANCELLED: "muted" } as const;

/** Vehicle loads: open ones, and starting a new one (ADR-103). */
export default async function LoadsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/loads">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const all = sp.status === "all";
  const [t, format, loads, warehouses] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listLoads(ctx, { status: all ? "all" : "open" }),
    listWarehouseOptions(ctx),
  ]);
  const base = `/o/${orgSlug}/inventory/loads`;
  return (
    <>
      <PageHeader title={t("loads.title")} description={t("loads.hint")} />
      <div className="space-y-6">
        <p className="text-sm">
          <Link href={all ? base : `${base}?status=all`} className="text-primary hover:underline">
            {all ? t("loads.showOpen") : t("loads.showAll")}
          </Link>
        </p>
        {loads.length === 0 ? (
          <EmptyState title={t("loads.empty")} />
        ) : (
          <Table label={t("loads.title")}>
            <thead>
              <tr>
                <Th>{t("loads.number")}</Th>
                <Th>{t("loads.vehicle")}</Th>
                <Th>{t("loads.warehouse")}</Th>
                <Th>{t("loads.orders")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {loads.map((l) => (
                <tr key={l.id}>
                  <Td>
                    <Link
                      href={`${base}/${l.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {l.number}
                    </Link>
                    <span className="text-muted block text-xs">
                      {format.dateTime(l.createdAt, {
                        dateStyle: "medium",
                        timeZone: ctx.timeZone,
                      })}
                    </span>
                  </Td>
                  <Td>
                    <span className="ltr-value">{l.vehicleRef}</span>
                    {l.driverName ? (
                      <span className="text-muted block text-xs">{l.driverName}</span>
                    ) : null}
                  </Td>
                  <Td className="ltr-value font-mono text-xs">{l.warehouse.code}</Td>
                  <Td className="ltr-value tabular-nums">{l._count.pickLists}</Td>
                  <Td>
                    <Badge tone={LOAD_TONES[l.status]}>{t(`loads.statuses.${l.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {holdsAnyGrant(ctx.grants, "inventory.transfer") && warehouses.length > 0 ? (
          <Card title={t("loads.newTitle")}>
            <LoadForm
              action={createLoadAction.bind(null, orgSlug)}
              warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
