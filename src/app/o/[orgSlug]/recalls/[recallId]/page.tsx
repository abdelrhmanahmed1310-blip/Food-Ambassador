import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AddLotsForm, CloseRecallForm, SupplierLotsForm } from "@/components/traceability/forms";
import { RecallStatusBadge } from "@/components/traceability/recall-badge";
import {
  Alert,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/print-button";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { listProductOptions } from "@/modules/catalog/service";
import { supplierOptions } from "@/modules/procurement/suppliers";
import { getRecall } from "@/modules/traceability/recalls";
import { searchLots } from "@/modules/traceability/trace";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, quantityFormatter } from "@/server/inventory-view";
import {
  activateRecallAction,
  addRecallLotsAction,
  addSupplierLotsAction,
  cancelRecallAction,
  closeRecallAction,
  removeRecallLotAction,
} from "../actions";

export default async function RecallPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/recalls/[recallId]">) {
  const { orgSlug, recallId } = await params;
  if (!isUuid(recallId)) notFound();
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const recall = await notFoundOnAppError(getRecall(ctx, recallId));
  const manage = hasPermission(ctx.grants, "recalls.manage");
  const draft = recall.status === "DRAFT";
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const [t, locale, format, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
  const [found, suppliers, products] =
    manage && draft
      ? await Promise.all([
          q ? searchLots(ctx, q) : Promise.resolve([]),
          supplierOptions(ctx),
          listProductOptions(ctx),
        ])
      : [[], [], []];
  const inScope = new Set(recall.lots.map((l) => l.lotId));
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const lotOf = new Map(recall.lots.map((l) => [l.lotId, l.lot]));
  const qty = (lotId: string, v: { toString(): string }) =>
    `${fmt(v)} ${lotOf.get(lotId)?.product.baseUom.code ?? ""}`;
  const base = `/o/${orgSlug}/recalls/${recall.id}`;
  return (
    <>
      <PageHeader
        title={`${recall.number} — ${recall.title}`}
        description={draft ? t("recalls.simulationHint") : undefined}
        actions={
          <>
            <RecallStatusBadge status={recall.status} />
            <PrintButton label={t("recalls.printReport")} />
          </>
        }
      />
      <div className="space-y-6">
        {draft ? <Alert tone="info">{t("recalls.simulationBanner")}</Alert> : null}
        <Card>
          <DescriptionList
            items={[
              {
                label: t("recalls.reason"),
                value: <span className="whitespace-pre-line">{recall.reason}</span>,
              },
              {
                label: t("purchasing.createdBy"),
                value: (
                  <>
                    <bdi>{recall.names.createdBy ?? "—"}</bdi> · <bdi>{dt(recall.createdAt)}</bdi>
                  </>
                ),
              },
              ...(recall.activatedAt
                ? [
                    {
                      label: t("recalls.activatedAt"),
                      value: (
                        <>
                          <bdi>{recall.names.activatedBy ?? "—"}</bdi> ·{" "}
                          <bdi>{dt(recall.activatedAt)}</bdi>
                        </>
                      ),
                    },
                  ]
                : []),
              ...(recall.closedAt
                ? [
                    {
                      label: t("recalls.closedAt"),
                      value: (
                        <>
                          <bdi>{recall.names.closedBy ?? "—"}</bdi> ·{" "}
                          <bdi>{dt(recall.closedAt)}</bdi>
                          {recall.outcome ? (
                            <> · {t(`recalls.outcomes.${recall.outcome}`)}</>
                          ) : null}
                          {recall.closeNote ? (
                            <>
                              {" "}
                              — <bdi>{recall.closeNote}</bdi>
                            </>
                          ) : null}
                        </>
                      ),
                    },
                  ]
                : []),
              {
                label: t("recalls.suppliers"),
                value:
                  recall.suppliers.length === 0
                    ? t("recalls.noSupplier")
                    : recall.suppliers.map((s) => (
                        <span key={s.id} className="block">
                          {s.code} — {(locale === "ar" && s.nameAr) || s.name}
                          {s.phone || s.email ? (
                            <span className="ltr-value text-muted">
                              {" "}
                              · {[s.phone, s.email].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                        </span>
                      )),
              },
            ]}
          />
        </Card>

        <Card title={t("recalls.scope")}>
          <Table label={t("recalls.scope")}>
            <thead>
              <tr>
                <Th>{t("inventory.lot")}</Th>
                <Th>{t("inventory.product")}</Th>
                <Th>{t("trace.received")}</Th>
                <Th>{t("recalls.writtenOff")}</Th>
                <Th>{t("trace.onHand")}</Th>
                {manage && draft ? <Th>{t("common.actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {recall.lots.map((l) => {
                const s = recall.lotSummaries.find((x) => x.lotId === l.lotId)!;
                return (
                  <tr key={l.id}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/traceability/lots/${l.lotId}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {l.lot.lotCode}
                      </Link>
                    </Td>
                    <Td>{productName(l.lot.product, locale)}</Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {qty(l.lotId, s.received)}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {qty(l.lotId, s.writtenOff)}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span
                        className="ltr-value whitespace-nowrap"
                        data-testid={`on-hand-${l.lot.lotCode}`}
                      >
                        {qty(l.lotId, s.onHand)}
                      </span>
                    </Td>
                    {manage && draft ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeRecallLotAction.bind(null, orgSlug, recall.id, l.lotId)}
                          label={t("common.remove")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {manage && draft ? (
            <div className="mt-4 space-y-4 print:hidden">
              <form method="get" action={base} className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">{t("trace.searchLabel")}</span>
                  <input
                    name="q"
                    defaultValue={q}
                    dir="ltr"
                    className="border-border bg-surface rounded-md border px-3 py-2"
                  />
                </label>
                <button
                  type="submit"
                  className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
                >
                  {t("common.search")}
                </button>
              </form>
              {found.filter((f) => !inScope.has(f.id)).length > 0 ? (
                <AddLotsForm
                  action={addRecallLotsAction.bind(null, orgSlug, recall.id)}
                  lots={found
                    .filter((f) => !inScope.has(f.id))
                    .map((f) => ({
                      value: f.id,
                      label: `${f.lotCode} — ${productName(f.product, locale)}`,
                      hint: f.product.sku,
                    }))}
                />
              ) : q ? (
                <p className="text-muted text-sm">{t("trace.noLots")}</p>
              ) : null}
              <SupplierLotsForm
                action={addSupplierLotsAction.bind(null, orgSlug, recall.id)}
                suppliers={suppliers.map((s) => ({
                  value: s.id,
                  label: `${s.code} — ${(locale === "ar" && s.nameAr) || s.name}`,
                }))}
                products={products.map((p) => ({
                  value: p.id,
                  label: `${p.sku} — ${productName(p, locale)}`,
                }))}
              />
            </div>
          ) : null}
        </Card>

        <Card title={draft ? t("recalls.affectedNow") : t("recalls.stockNow")}>
          {recall.stockNow.length === 0 ? (
            <p className="text-muted text-sm">{t("trace.noStock")}</p>
          ) : (
            <Table label={t("recalls.affectedNow")}>
              <thead>
                <tr>
                  <Th>{t("common.warehouse")}</Th>
                  <Th>{t("inventory.lot")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th>{t("common.quantity")}</Th>
                </tr>
              </thead>
              <tbody>
                {recall.stockNow.map((s) => (
                  <tr key={`${s.warehouseId}-${s.locationId}-${s.lotId}-${s.stockStatus}`}>
                    <Td>
                      <span className="ltr-value font-mono text-xs">
                        {s.warehouse.code}
                        {s.location ? ` / ${s.location.code}` : ""}
                      </span>
                      <span className="block">{s.warehouse.name}</span>
                    </Td>
                    <Td>
                      <span className="ltr-value font-mono text-xs">
                        {lotOf.get(s.lotId as string)?.lotCode}
                      </span>
                    </Td>
                    <Td>{t(`inventory.statuses.${s.stockStatus}`)}</Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {qty(s.lotId as string, s.onHandQuantity)}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {recall.inTransit.length > 0 ? (
            <p className="text-muted mt-3 text-sm">{t("recalls.inTransitNote")}</p>
          ) : null}
        </Card>

        {recall.stock.length > 0 ? (
          <Card title={t("recalls.stockAtActivation")}>
            <ul className="space-y-1 text-sm">
              {recall.stock.map((s) => (
                <li key={s.id}>
                  <span className="ltr-value font-mono text-xs">{s.warehouse.code}</span> ·{" "}
                  {s.lot.lotCode} · {t(`inventory.statuses.${s.stockStatus}`)} ·{" "}
                  <span className="ltr-value tabular-nums">{qty(s.lotId, s.quantity)}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {recall.documents.length > 0 ? (
          <Card title={t("recalls.documents")}>
            <ul className="space-y-1 text-sm">
              {recall.documents.map((d) => (
                <li key={d.id}>
                  <Link
                    href={`/o/${orgSlug}/inventory/documents/${d.document.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {d.document.number}
                  </Link>{" "}
                  · {t(`recalls.documentKinds.${d.kind}`)} ·{" "}
                  <span className="ltr-value font-mono text-xs">{d.document.warehouse.code}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {manage && draft && recall.lots.length > 0 ? (
          <Card title={t("recalls.activate")}>
            <p className="text-muted mb-3 text-sm">{t("recalls.activateHint")}</p>
            <ConfirmActionButton
              action={activateRecallAction.bind(null, orgSlug, recall.id)}
              label={t("recalls.activate")}
              confirmMessage={t("recalls.confirmActivate")}
              variant="danger"
            />
          </Card>
        ) : null}
        {manage && recall.status === "ACTIVE" ? (
          <Card title={t("recalls.close")}>
            <CloseRecallForm action={closeRecallAction.bind(null, orgSlug, recall.id)} />
          </Card>
        ) : null}
        {manage && draft ? (
          <div className="print:hidden">
            <ConfirmActionButton
              action={cancelRecallAction.bind(null, orgSlug, recall.id)}
              label={t("recalls.cancel")}
              confirmMessage={t("recalls.confirmCancel")}
              variant="secondary"
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
