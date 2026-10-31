import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { AttentionItem } from "@/modules/analytics/attention";
import { moneyFormatter } from "@/server/inventory-view";

const TONE = {
  danger: "border-danger/40 bg-danger-surface",
  warning: "border-warning/40 bg-warning-surface",
  info: "border-border bg-surface",
} as const;

export async function AttentionList({
  items,
  base,
  currency,
}: {
  items: AttentionItem[];
  base: string;
  currency: string;
}) {
  const [t, money] = await Promise.all([getTranslations("attention"), moneyFormatter(currency)]);
  if (items.length === 0) return <p className="text-muted text-sm">{t("nothing")}</p>;
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li
          key={i.key}
          className={`rounded-md border p-3 ${TONE[i.tone]}`}
          data-testid={`attention-${i.key}`}
        >
          <Link href={`${base}${i.href}`} className="font-medium hover:underline">
            {t(`items.${i.key}`, { count: i.count })}
          </Link>
          {i.amount ? (
            <span className="ltr-value ms-2 text-sm tabular-nums">{money.money(i.amount)}</span>
          ) : null}
          {i.links && i.links.length > 1 ? (
            <span className="ms-2 inline-flex flex-wrap gap-x-2 text-xs">
              {i.links.map((l) => (
                <Link
                  key={l.href}
                  href={`${base}${l.href}`}
                  className="ltr-value text-primary font-mono hover:underline"
                >
                  {l.label}
                </Link>
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
