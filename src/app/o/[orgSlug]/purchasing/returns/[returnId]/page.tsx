import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ReturnStatusBadge } from "@/components/procurement/badges";
import { ReasonForm } from "@/components/procurement/forms";
import { LinkCreditNoteForm, ReturnLineForm } from "@/components/procurement/return-forms";
import {
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { getSupplierReturn } from "@/modules/procurement/returns";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyIn } from "@/server/fx-view";
import { productName, quantityFormatter } from "@/server/inventory-view";
import {
  addReturnLineAction,
  cancelReturnAction,
  linkCreditAction,
  postReturnAction,
  removeReturnLineAction,
  reverseReturnAction,
} from "../actions";

export default async function ReturnPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/returns/[returnId]">) {
  const { orgSlug, returnId } = await params;
  if (!isUuid(returnId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const view = await notFoundOnAppError(getSupplierReturn(ctx, returnId));
  const { ret, supplier, lines, documents, creditNote, returnable, creditNotes, can } = view;
  const [t, locale, format, qty, moneyOf] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyIn([ret.currency]),
  ]);
  const money = moneyOf(ret.currency);
  const date = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: ctx.timeZone }) : "—";
  const posting = documents.find((d) => d.id === ret.inventoryDocumentId);
  const reversal = documents.find((d) => d.id === ret.reversalDocumentId);
  const supplierName = (locale === "ar" && supplier.nameAr) || supplier.name;

  return (
    <>
      <PageHeader
        title={ret.number}
        description={`${supplierName} · ${ret.warehouse.code} — ${ret.warehouse.name}`}
        actions={
          <>
            <ReturnStatusBadge status={ret.status} />
            {lines.length > 0 ? (
              <a
                href={`/o/${orgSlug}/purchasing/returns/${ret.id}/pdf`}
                className={buttonClass("secondary")}
              >
                {t("returns.pdf")}
              </a>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("returns.reason"), value: t(`returns.reasons.${ret.reason}`) },
              {
                label: t("returns.expectedCredit"),
                value: (
                  <span className="ltr-value tabular-nums">{money.money(ret.totalAmount)}</span>
                ),
              },
              { label: t("returns.postedAt"), value: date(ret.postedAt) },
              ...(posting
                ? [
                    {
                      label: t("returns.stockDocument"),
                      value: (
                        <Link
                          href={`/o/${orgSlug}/inventory/documents/${posting.id}`}
                          className="ltr-value text-primary font-mono text-xs hover:underline"
                        >
                          {posting.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              ...(reversal
                ? [
                    {
                      label: t("returns.reversedBy"),
                      value: `${reversal.number} — ${ret.decisionReason}`,
                    },
                  ]
                : []),
              ...(ret.status === "CANCELLED"
                ? [{ label: t("returns.cancelReason"), value: ret.decisionReason ?? "—" }]
                : []),
              ...(creditNote
                ? [
                    {
                      label: t("returns.creditNote"),
                      value: (
                        <>
                          <Link
                            href={`/o/${orgSlug}/purchasing/payables/settlements/${creditNote.id}`}
                            className="ltr-value text-primary font-mono text-xs hover:underline"
                          >
                            {creditNote.number}
                          </Link>{" "}
                          <span className="ltr-value tabular-nums">
                            {creditNote.netAmount ? money.money(creditNote.netAmount) : ""}
                          </span>
                        </>
                      ),
                    },
                  ]
                : []),
              { label: t("common.note"), value: ret.note ?? "—" },
            ]}
          />
        </Card>

        <Card title={t("returns.linesTitle")}>
          {lines.length === 0 ? (
            <EmptyState title={t("returns.noLines")} />
          ) : (
            <Table label={t("returns.linesTitle")}>
              <thead>
                <tr>
                  <Th>{t("purchasing.product")}</Th>
                  <Th>{t("returns.receipt")}</Th>
                  <Th>{t("common.quantity")}</Th>
                  <Th>{t("returns.chargedPrice")}</Th>
                  <Th>{t("purchasing.lineTotal")}</Th>
                  {can.edit ? <Th>{t("common.actions")}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      {productName(l.product, locale)}
                      <span className="ltr-value text-muted block font-mono text-xs">
                        {l.product.sku}
                        {l.receiptLine.lot ? ` · ${l.receiptLine.lot.lotCode}` : ""}
                      </span>
                      <span className="text-muted block text-xs">
                        {t(
                          l.fromStatus === "QUARANTINE"
                            ? "returns.fromQuarantine"
                            : "returns.fromAvailable",
                        )}
                      </span>
                    </Td>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/purchasing/receipts/${l.receiptLine.receipt.id}`}
                        className="ltr-value text-primary font-mono text-xs hover:underline"
                      >
                        {l.receiptLine.receipt.number}
                      </Link>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {qty(l.quantity)} {l.uom.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {money.unitCost(l.unitPrice)}
                      </span>
                    </Td>
                    <Td className="tabular-nums">
                      <span className="ltr-value whitespace-nowrap">
                        {money.money(l.lineTotal)}
                      </span>
                    </Td>
                    {can.edit ? (
                      <Td>
                        <ConfirmActionButton
                          action={removeReturnLineAction.bind(null, orgSlug, ret.id, l.id)}
                          label={t("common.remove")}
                          variant="secondary"
                        />
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {can.edit ? (
          <Card title={t("returns.addTitle")}>
            <p className="text-muted mb-3 text-xs">{t("returns.addHint")}</p>
            {returnable.filter((r) => !r.onThisReturn).length === 0 ? (
              <EmptyState title={t("returns.nothingToAdd")} />
            ) : (
              <ul className="divide-border divide-y text-sm">
                {returnable
                  .filter((r) => !r.onThisReturn)
                  .map((r) => (
                    <li key={r.id} className="py-3">
                      <p>
                        <span className="font-medium">{productName(r.product, locale)}</span>{" "}
                        <span className="ltr-value text-muted font-mono text-xs">
                          {r.product.sku}
                          {r.lot ? ` · ${r.lot.lotCode}` : ""}
                        </span>
                      </p>
                      <p className="text-muted text-xs">
                        <span className="ltr-value font-mono">{r.receipt.number}</span> ·{" "}
                        {date(r.receipt.receivedAt)} ·{" "}
                        {t("returns.left", { quantity: `${qty(r.remaining)} ${r.uom.code}` })} ·{" "}
                        <span className="ltr-value">{money.unitCost(r.unitPrice)}</span>
                      </p>
                      <div className="mt-2">
                        <ReturnLineForm
                          action={addReturnLineAction.bind(null, orgSlug, ret.id)}
                          receiptLineId={r.id}
                          unit={r.uom.code}
                          remaining={r.remaining.toString()}
                          quarantine={r.quarantine}
                        />
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </Card>
        ) : null}

        {can.post || can.cancel ? (
          <Card>
            <p className="text-muted mb-3 text-sm">{t("returns.postHint")}</p>
            <div className="flex flex-wrap items-start gap-4">
              {can.post ? (
                <ConfirmActionButton
                  action={postReturnAction.bind(null, orgSlug, ret.id)}
                  label={t("returns.post")}
                  variant="primary"
                  confirmMessage={t("returns.postConfirm")}
                />
              ) : null}
              {can.cancel ? (
                <div className="w-full max-w-md">
                  <ReasonForm
                    action={cancelReturnAction.bind(null, orgSlug, ret.id)}
                    label={t("returns.cancelReason")}
                    submitLabel={t("returns.cancel")}
                    variant="danger"
                  />
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}

        {can.credit ? (
          <Card title={t("returns.creditTitle")}>
            <p className="text-muted mb-3 text-xs">{t("returns.creditHint")}</p>
            {creditNotes.length === 0 ? (
              <p className="text-sm">
                {t("returns.noCreditNotes")}{" "}
                <Link
                  href={`/o/${orgSlug}/purchasing/payables`}
                  className="text-primary hover:underline"
                >
                  {t("returns.recordCredit")}
                </Link>
              </p>
            ) : (
              <LinkCreditNoteForm
                action={linkCreditAction.bind(null, orgSlug, ret.id)}
                creditNotes={creditNotes.map((c) => ({
                  value: c.id,
                  label: `${c.number}${c.supplierDocumentNo ? ` (${c.supplierDocumentNo})` : ""} · ${
                    c.netAmount ? money.money(c.netAmount) : ""
                  } · ${c.date.toISOString().slice(0, 10)}`,
                }))}
              />
            )}
          </Card>
        ) : null}

        {can.reverse ? (
          <Card title={t("returns.reverseTitle")}>
            <p className="text-muted mb-3 text-xs">{t("returns.reverseHint")}</p>
            <div className="max-w-md">
              <ReasonForm
                action={reverseReturnAction.bind(null, orgSlug, ret.id)}
                label={t("returns.reverseReason")}
                submitLabel={t("returns.reverse")}
                variant="danger"
              />
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
