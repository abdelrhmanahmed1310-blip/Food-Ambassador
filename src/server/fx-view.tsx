import "server-only";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { moneyFormatter } from "@/server/inventory-view";

/**
 * Description-list items for a document's currency (ADR-050): its currency,
 * and for a foreign currency the rate used and the base-currency amount.
 */
export async function fxItems(
  baseCurrency: string,
  doc: {
    currency: string;
    exchangeRate: { toString(): string } | null;
    rateDate?: Date | null;
  },
  baseAmount?: { label: string; value: { toString(): string } | null },
): Promise<Array<{ label: string; value: ReactNode }>> {
  const t = await getTranslations("fx");
  const items: Array<{ label: string; value: ReactNode }> = [
    { label: t("currency"), value: <span className="ltr-value">{doc.currency}</span> },
  ];
  if (doc.currency === baseCurrency || doc.exchangeRate === null) return items;
  const base = await moneyFormatter(baseCurrency);
  items.push({
    label: t("rateUsed"),
    value: (
      <span className="ltr-value" data-testid="fx-rate">
        1 {doc.currency} = {doc.exchangeRate.toString().replace(/\.?0+$/, "")} {baseCurrency}
        {doc.rateDate ? ` (${doc.rateDate.toISOString().slice(0, 10)})` : ""}
      </span>
    ),
  });
  if (baseAmount?.value != null)
    items.push({
      label: baseAmount.label,
      value: (
        <span className="ltr-value tabular-nums" data-testid="fx-base-amount">
          {base.money(baseAmount.value)}
        </span>
      ),
    });
  return items;
}

/** Money formatters for several currencies (lists mixing documents of different currencies). */
export async function moneyIn(currencies: Iterable<string>) {
  const list = [...new Set(currencies)];
  const map = new Map(
    await Promise.all(list.map(async (c) => [c, await moneyFormatter(c)] as const)),
  );
  return (currency: string) =>
    map.get(currency) ?? (map.values().next().value as Awaited<ReturnType<typeof moneyFormatter>>);
}
