import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/inventory/stock-badges";
import { Table, Td, Th } from "@/components/ui/primitives";
import type { listMovements } from "@/modules/inventory/queries";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";

type Movement = Awaited<ReturnType<typeof listMovements>>["items"][number];

export async function MovementsTable({
  rows,
  orgSlug,
  timeZone,
  currency,
  showDocument = true,
}: {
  rows: Movement[];
  orgSlug: string;
  timeZone: string;
  currency: string;
  showDocument?: boolean;
}) {
  const [t, locale, format, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(currency),
  ]);
  // Cost columns appear only when the user may see costs for some of the rows.
  const showCost = rows.some((m) => m.costVisible);
  return (
    <Table label={t("inventory.movementsTitle")}>
      <thead>
        <tr>
          <Th>{t("common.date")}</Th>
          {showDocument ? <Th>{t("inventory.document")}</Th> : null}
          <Th>{t("inventory.movementType")}</Th>
          <Th>{t("inventory.product")}</Th>
          <Th>{t("common.warehouse")}</Th>
          <Th>{t("inventory.lot")}</Th>
          <Th>{t("common.quantity")}</Th>
          {showCost ? <Th>{t("inventory.value")}</Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => {
          const negative = m.quantityDelta.toString().startsWith("-");
          return (
            <tr key={m.id}>
              <Td className="whitespace-nowrap">
                {format.dateTime(m.postedAt, { dateStyle: "short", timeStyle: "short", timeZone })}
                {m.postedByName ? (
                  <span className="text-muted block text-xs">{m.postedByName}</span>
                ) : null}
              </Td>
              {showDocument ? (
                <Td>
                  <Link
                    href={`/o/${orgSlug}/inventory/documents/${m.document.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {m.document.number}
                  </Link>
                </Td>
              ) : null}
              <Td>
                {t(`inventory.movementTypes.${m.movementType}`)}
                <span className="mt-1 block">
                  <StatusBadge status={m.stockStatus} />
                </span>
                {m.reasonCode ? (
                  <span className="text-muted block text-xs">
                    {t.has(`inventory.reasons.${m.reasonCode}`)
                      ? t(`inventory.reasons.${m.reasonCode}`)
                      : m.reasonCode}
                  </span>
                ) : null}
              </Td>
              <Td>
                {productName(m.product, locale)}
                <span className="ltr-value text-muted block font-mono text-xs">
                  {m.product.sku}
                </span>
              </Td>
              <Td>
                <span className="ltr-value font-mono text-xs">
                  {m.warehouse.code}
                  {m.location ? ` / ${m.location.code}` : ""}
                </span>
              </Td>
              <Td>
                <span className="ltr-value font-mono text-xs">{m.lot?.lotCode ?? "—"}</span>
              </Td>
              <Td className="tabular-nums">
                <span
                  className={`ltr-value whitespace-nowrap ${negative ? "text-danger" : "text-success"}`}
                >
                  {negative ? "" : "+"}
                  {fmt(m.quantityDelta)} {m.product.baseUom.code}
                </span>
                {m.enteredUom.code !== m.product.baseUom.code ? (
                  <span className="text-muted block text-xs">
                    {t("inventory.enteredAs")}{" "}
                    <span className="ltr-value whitespace-nowrap">
                      {fmt(m.enteredQuantity)} {m.enteredUom.code}
                    </span>
                  </span>
                ) : null}
              </Td>
              {showCost ? (
                <Td className="tabular-nums">
                  {m.costVisible && m.valueDelta !== null && m.costSource ? (
                    <>
                      <span className="ltr-value whitespace-nowrap">
                        {money.money(m.valueDelta)}
                      </span>
                      <span className="text-muted block text-xs">
                        {m.unitCost !== null ? (
                          <span className="ltr-value whitespace-nowrap">
                            {money.unitCost(m.unitCost)} / {m.product.baseUom.code}
                          </span>
                        ) : null}
                        <span className="block">{t(`inventory.costSources.${m.costSource}`)}</span>
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
