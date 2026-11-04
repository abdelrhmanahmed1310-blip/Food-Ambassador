import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getWave } from "@/modules/wms/picking";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";
import { PickStatusBadge } from "../../badge";

/** A wave: its pick lists and the consolidated, walk-ordered pick sheet (ADR-102). */
export default async function WavePage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/picking/waves/[waveId]">) {
  const { orgSlug, waveId } = await params;
  if (!isUuid(waveId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const w = await notFoundOnAppError(getWave(ctx, waveId));
  const [t, locale, fmt] = await Promise.all([getTranslations(), getLocale(), quantityFormatter()]);
  return (
    <>
      <PageHeader
        title={`${w.number} — ${w.warehouse.code}`}
        description={w.note ?? t("picking.waveSheetHint")}
        actions={
          <a
            href={`/o/${orgSlug}/inventory/picking/waves/${w.id}/pdf`}
            className={buttonClass("secondary")}
          >
            {t("picking.sheet")}
          </a>
        }
      />
      <div className="space-y-6">
        <h2 className="text-lg font-semibold">{t("picking.waveSheet")}</h2>
        {w.sheet.length === 0 ? (
          <EmptyState title={t("picking.nothingToPick")} />
        ) : (
          <Table label={t("picking.waveSheet")}>
            <thead>
              <tr>
                <Th>{t("picking.from")}</Th>
                <Th>{t("picking.product")}</Th>
                <Th>{t("picking.lot")}</Th>
                <Th>{t("picking.planned")}</Th>
                <Th>{t("picking.forLists")}</Th>
              </tr>
            </thead>
            <tbody>
              {w.sheet.map((r, i) => (
                <tr key={i}>
                  <Td className="ltr-value font-mono text-xs">
                    {r.locationCode ?? t("picking.noLocation")}
                  </Td>
                  <Td>
                    {r.product.sku} — {productName(r.product, locale)}
                  </Td>
                  <Td className="ltr-value font-mono text-xs">{r.lot?.lotCode ?? "—"}</Td>
                  <Td className="ltr-value tabular-nums">{`${fmt(r.quantity)} ${r.product.baseUom.code}`}</Td>
                  <Td className="ltr-value font-mono text-xs">{r.lists.join(", ")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <h2 className="text-lg font-semibold">{t("picking.title")}</h2>
        <Table label={t("picking.title")}>
          <thead>
            <tr>
              <Th>{t("picking.number")}</Th>
              <Th>{t("picking.order")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {w.pickLists.map((l) => (
              <tr key={l.id}>
                <Td>
                  <Link
                    href={`/o/${orgSlug}/inventory/picking/${l.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {l.number}
                  </Link>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{l.salesOrder.number}</span>
                  <span className="text-muted block text-xs">{l.salesOrder.customer.name}</span>
                </Td>
                <Td>
                  <PickStatusBadge status={l.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}
