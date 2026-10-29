import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/inventory/stock-badges";
import { Table, Td, Th } from "@/components/ui/primitives";
import type { listMovements } from "@/modules/inventory/queries";
import { productName, quantityFormatter } from "@/server/inventory-view";

type Movement = Awaited<ReturnType<typeof listMovements>>["items"][number];

export async function MovementsTable({
  rows,
  orgSlug,
  timeZone,
  showDocument = true,
}: {
  rows: Movement[];
  orgSlug: string;
  timeZone: string;
  showDocument?: boolean;
}) {
  const [t, locale, format, fmt] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
  ]);
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
          <Th>{t("inventory.status")}</Th>
          <Th>{t("common.quantity")}</Th>
          <Th>{t("inventory.enteredAs")}</Th>
          <Th>{t("common.by")}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => {
          const negative = m.quantityDelta.toString().startsWith("-");
          return (
            <tr key={m.id}>
              <Td className="whitespace-nowrap">
                {format.dateTime(m.postedAt, { dateStyle: "short", timeStyle: "short", timeZone })}
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
              <Td>
                <StatusBadge status={m.stockStatus} />
              </Td>
              <Td className={`tabular-nums ${negative ? "text-danger" : "text-success"}`}>
                <span className="ltr-value">
                  {negative ? "" : "+"}
                  {fmt(m.quantityDelta)} {m.product.baseUom.code}
                </span>
              </Td>
              <Td className="text-muted tabular-nums">
                <span className="ltr-value">
                  {fmt(m.enteredQuantity)} {m.enteredUom.code}
                </span>
              </Td>
              <Td>{m.postedByName}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
