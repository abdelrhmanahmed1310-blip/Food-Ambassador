import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ShipmentStatusBadge, type ShipmentStatus } from "@/components/inventory/shipment-badge";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listShipments } from "@/modules/inventory/shipments";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const STATUSES: ShipmentStatus[] = ["DRAFT", "IN_TRANSIT", "RECEIVED", "CANCELLED"];

export default async function ShipmentsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/shipments">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const status = STATUSES.find((s) => s === sp.status);
  const page = pageSchema.parse(sp.page);
  const [t, format, result] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listShipments(ctx, { status, page }),
  ]);
  const base = `/o/${orgSlug}/inventory/shipments`;
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border hover:bg-surface-muted"
    }`;
  return (
    <>
      <PageHeader
        title={t("shipments.title")}
        actions={
          holdsAnyGrant(ctx.grants, "inventory.transfer") ? (
            <LinkButton href={`${base}/new`}>{t("shipments.new")}</LinkButton>
          ) : null
        }
      />
      <nav aria-label={t("common.status")} className="mb-4 flex flex-wrap gap-2">
        <Link href={base} className={chip(!status)} aria-current={!status ? "page" : undefined}>
          {t("common.all")}
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`${base}?status=${s}`}
            className={chip(status === s)}
            aria-current={status === s ? "page" : undefined}
          >
            {t(`shipments.statuses.${s}`)}
          </Link>
        ))}
      </nav>
      {result.total === 0 ? (
        <EmptyState title={t("shipments.empty")} />
      ) : (
        <Table label={t("shipments.title")}>
          <thead>
            <tr>
              <Th>{t("shipments.number")}</Th>
              <Th>{t("shipments.from")}</Th>
              <Th>{t("shipments.to")}</Th>
              <Th>{t("shipments.lines")}</Th>
              <Th>{t("shipments.expectedOn")}</Th>
              <Th>{t("shipments.dispatchedAt")}</Th>
              <Th>{t("shipments.receivedAt")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((s) => (
              <tr key={s.id}>
                <Td>
                  <Link
                    href={`${base}/${s.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {s.number}
                  </Link>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{s.from.code}</span>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{s.to.code}</span>
                </Td>
                <Td className="tabular-nums">{s._count.lines}</Td>
                <Td className="whitespace-nowrap">
                  {s.expectedOn?.toISOString().slice(0, 10) ?? "—"}
                </Td>
                <Td className="whitespace-nowrap">{dt(s.dispatchedAt)}</Td>
                <Td className="whitespace-nowrap">{dt(s.receivedAt)}</Td>
                <Td>
                  <ShipmentStatusBadge status={s.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={base}
        params={{ status }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
