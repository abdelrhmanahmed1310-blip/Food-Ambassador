import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { TradeDocumentForm } from "@/components/trade/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import {
  canManageTradeSetup,
  canSeeTradeDocuments,
  listTradeDocuments,
  tradeDocumentOptions,
} from "@/modules/trade/documents";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { addProductDocumentAction } from "./actions";

const STATE_TONE = {
  NO_EXPIRY: "muted",
  VALID: "success",
  EXPIRING: "warning",
  EXPIRED: "danger",
} as const;

/** Trade documents held, with their expiry (ADR-114). */
export default async function TradeDocumentsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/trade/documents">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeTradeDocuments(ctx)) notFound();
  const state = typeof sp.state === "string" ? sp.state : "";
  const typeId = typeof sp.type === "string" ? sp.type : "";
  const [t, locale, rows, options] = await Promise.all([
    getTranslations(),
    getLocale(),
    listTradeDocuments(ctx, { state, typeId }),
    tradeDocumentOptions(ctx),
  ]);
  const name = (x: { name: string; nameAr: string | null }) =>
    (locale === "ar" && x.nameAr) || x.name;
  const base = `/o/${orgSlug}/trade`;
  const productTypes = options.types.filter((x) => x.scope === "PRODUCT");
  return (
    <>
      <PageHeader
        title={t("tradeDocs.title")}
        description={t("tradeDocs.hint")}
        actions={
          <Link href={`${base}/setup`} className={buttonClass("secondary")}>
            {t("tradeDocs.setup")}
          </Link>
        }
      />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("tradeDocs.expiry")}</span>
            <select name="state" defaultValue={state} className={`${inputClass} w-auto`}>
              <option value="">{t("tradeDocs.allCurrent")}</option>
              <option value="EXPIRING">{t("tradeDocs.states.EXPIRING")}</option>
              <option value="EXPIRED">{t("tradeDocs.states.EXPIRED")}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("tradeDocs.type")}</span>
            <select name="type" defaultValue={typeId} className={`${inputClass} w-auto`}>
              <option value="">{t("tradeDocs.allTypes")}</option>
              {options.types.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} — {name(x)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("trade.show")}
          </button>
        </form>
        {rows.length === 0 ? (
          <EmptyState title={t("tradeDocs.empty")} />
        ) : (
          <Table label={t("tradeDocs.title")}>
            <thead>
              <tr>
                <Th>{t("tradeDocs.type")}</Th>
                <Th>{t("tradeDocs.heldFor")}</Th>
                <Th>{t("tradeDocs.number")}</Th>
                <Th>{t("tradeDocs.expiresOn")}</Th>
                <Th>{t("tradeDocs.expiry")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} data-testid={`trade-doc-${d.id}`}>
                  <Td>
                    <Link
                      href={`${base}/documents/${d.id}`}
                      className="text-primary hover:underline"
                    >
                      {d.documentType.code} — {name(d.documentType)}
                    </Link>
                  </Td>
                  <Td>
                    {d.product ? (
                      `${d.product.sku} — ${d.product.nameEn}`
                    ) : d.shipment ? (
                      <Link
                        href={`${base}/shipments/${d.shipment.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {d.shipment.number}
                      </Link>
                    ) : null}
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{d.number ?? "—"}</span>
                  </Td>
                  <Td>
                    <span className="ltr-value">{d.expiresOn ?? "—"}</span>
                  </Td>
                  <Td>
                    <Badge tone={STATE_TONE[d.state]}>{t(`tradeDocs.states.${d.state}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {canManageTradeSetup(ctx) && productTypes.length > 0 ? (
          <Card title={t("tradeDocs.addProductDocument")}>
            <TradeDocumentForm
              action={addProductDocumentAction.bind(null, orgSlug)}
              submitLabel={t("tradeDocs.add")}
              types={productTypes.map((x) => ({ value: x.id, label: `${x.code} — ${name(x)}` }))}
              products={options.products.map((p) => ({
                value: p.id,
                label: `${p.sku} — ${p.nameEn}`,
              }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
