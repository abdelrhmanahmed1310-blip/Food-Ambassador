import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { canManageShipments, canSeeShipments, listShipments } from "@/modules/trade/shipments";
import { SHIPMENT_STATUSES } from "@/modules/trade/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const TONE = {
  PLANNED: "neutral",
  IN_TRANSIT: "warning",
  ARRIVED: "success",
  CLEARED: "success",
  CLOSED: "muted",
  CANCELLED: "muted",
} as const;

/** Import shipments with their ETA and lateness (ADR-113). */
export default async function ImportShipmentsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/trade/shipments">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeShipments(ctx)) notFound();
  const status = typeof sp.status === "string" ? sp.status : "OPEN";
  const [t, rows] = await Promise.all([
    getTranslations(),
    listShipments(ctx, { status: status === "ALL" ? "" : status }),
  ]);
  const base = `/o/${orgSlug}/trade/shipments`;
  return (
    <>
      <PageHeader
        title={t("trade.title")}
        description={t("trade.hint")}
        actions={
          canManageShipments(ctx) ? (
            <Link href={`${base}/new`} className={buttonClass("primary")}>
              {t("trade.new")}
            </Link>
          ) : null
        }
      />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("trade.status")}</span>
            <select name="status" defaultValue={status} className={`${inputClass} w-auto`}>
              <option value="OPEN">{t("trade.open")}</option>
              <option value="ALL">{t("trade.all")}</option>
              {SHIPMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`trade.statuses.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("trade.show")}
          </button>
        </form>
        {rows.length === 0 ? (
          <EmptyState title={t("trade.empty")} />
        ) : (
          <Table label={t("trade.title")}>
            <thead>
              <tr>
                <Th>{t("trade.number")}</Th>
                <Th>{t("trade.supplier")}</Th>
                <Th>{t("trade.warehouse")}</Th>
                <Th>{t("trade.mode")}</Th>
                <Th>{t("trade.transportDocument")}</Th>
                <Th>{t("trade.eta")}</Th>
                <Th>{t("trade.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} data-testid={`shipment-${s.number}`}>
                  <Td>
                    <Link
                      href={`${base}/${s.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {s.number}
                    </Link>
                  </Td>
                  <Td>
                    {s.supplier.code} — {s.supplier.name}
                  </Td>
                  <Td>{s.warehouse.code}</Td>
                  <Td>{t(`trade.modes.${s.mode}`)}</Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">
                      {s.transportDocument ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    <span className="ltr-value whitespace-nowrap">{s.eta ?? "—"}</span>
                    {s.daysLate ? (
                      <span className="block">
                        <Badge tone="danger">{t("trade.daysLate", { days: s.daysLate })}</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={TONE[s.status]}>{t(`trade.statuses.${s.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
