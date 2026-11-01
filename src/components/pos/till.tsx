"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { Decimal } from "@/lib/decimal";
import { lineAmounts } from "@/modules/pos/rules";
import type { TillData } from "@/modules/pos/service";

type Channel = TillData["channels"][number]["channel"];
type Item = TillData["channels"][number]["items"][number];
type SubmitResult =
  | { ok: true; id: string; number: string; gross: string; change: string; shortfalls: number }
  | { ok: false; error: string };

interface CartLine {
  key: string;
  item: Item;
  quantity: number;
  optionIds: string[];
  optionNames: string[];
  unit: Decimal;
}

const named = (x: { name: string; nameAr: string | null }, locale: string) =>
  (locale === "ar" && x.nameAr) || x.name;

/**
 * The cashier screen (ADR-059). Prices, options and VAT come from the server
 * for today; the total shown is the one the server recomputes and checks. One
 * order id is kept per submission, so retrying after a lost response cannot
 * charge twice.
 */
export function Till({
  orgSlug,
  data,
  submit,
}: {
  orgSlug: string;
  data: TillData;
  submit: (payload: unknown) => Promise<SubmitResult>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const money = useMemo(
    () =>
      new Intl.NumberFormat(`${locale}-u-nu-latn`, {
        style: "currency",
        currency: data.currency,
      }),
    [locale, data.currency],
  );
  const fmt = (d: Decimal) => money.format(d.toString() as unknown as number);
  const channels = data.channels.filter((c) => c.items.length > 0);
  const [channel, setChannel] = useState<Channel>(channels[0]?.channel ?? "DINE_IN");
  const items = data.channels.find((c) => c.channel === channel)?.items ?? [];
  const categories = [...new Map(items.map((i) => [i.category.id, i.category])).values()];
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [choosing, setChoosing] = useState<Item | null>(null);
  const [paying, setPaying] = useState<"CASH" | "CARD" | null>(null);
  const [tendered, setTendered] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Extract<SubmitResult, { ok: true }> | null>(null);
  const [pending, startTransition] = useTransition();
  const orderId = useRef<string | null>(null);

  const amounts = cart.map((l) =>
    lineAmounts(
      l.unit,
      new Decimal(l.quantity),
      l.item.includesTax,
      l.item.taxRate === null ? null : new Decimal(l.item.taxRate),
      data.currency,
    ),
  );
  const total = amounts.reduce((a, x) => a.plus(x.gross), new Decimal(0));
  const tax = amounts.reduce((a, x) => a.plus(x.tax), new Decimal(0));
  const tenderedValue = /^\d+(\.\d+)?$/.test(tendered) ? new Decimal(tendered) : null;
  const change = tenderedValue && tenderedValue.gte(total) ? tenderedValue.minus(total) : null;

  const reset = () => {
    setCart([]);
    setPaying(null);
    setTendered("");
    setError(null);
    orderId.current = null;
  };

  const add = (item: Item, optionIds: string[] = []) => {
    const options = item.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id));
    const unit = options.reduce((a, o) => a.plus(o.priceDelta), new Decimal(item.price));
    const key = `${item.id}:${[...optionIds].sort().join(",")}`;
    setDone(null);
    setError(null);
    setCart((c) => {
      const existing = c.find((l) => l.key === key);
      if (existing) return c.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      return [
        ...c,
        {
          key,
          item,
          quantity: 1,
          optionIds,
          optionNames: options.map((o) => named(o, locale)),
          unit,
        },
      ];
    });
  };

  const changeQuantity = (key: string, delta: number) =>
    setCart((c) =>
      c
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );

  const pay = (method: "CASH" | "CARD") => {
    if (method === "CASH" && (!tenderedValue || tenderedValue.lt(total))) {
      setError(t("pos.tenderedTooLow"));
      return;
    }
    orderId.current ??= crypto.randomUUID();
    const payload = {
      orderId: orderId.current,
      registerId: data.register.id,
      channel,
      lines: cart.map((l) => ({
        itemId: l.item.id,
        quantity: String(l.quantity),
        optionIds: l.optionIds,
      })),
      payments: [
        method === "CASH"
          ? { method, amount: total.toFixed(), tendered: tenderedValue!.toFixed() }
          : { method, amount: total.toFixed() },
      ],
      expectedTotal: total.toFixed(),
    };
    setError(null);
    startTransition(async () => {
      try {
        const r = await submit(payload);
        if (r.ok) {
          reset();
          setDone(r);
        } else setError(r.error);
      } catch {
        // Lost connection: the same order id is sent again on retry.
        setError(t("pos.retry"));
      }
    });
  };

  if (!data.shift)
    return (
      <p role="alert" className="text-danger">
        {t("pos.noOpenShift")}
      </p>
    );

  const shown = category ? items.filter((i) => i.category.id === category) : items;
  const chip = (active: boolean) =>
    `min-h-11 rounded-full border px-4 text-sm font-medium ${
      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface"
    }`;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
      <section aria-label={t("pos.items")} className="space-y-3">
        <div role="tablist" aria-label={t("pos.channel")} className="flex flex-wrap gap-2">
          {channels.map((c) => (
            <button
              key={c.channel}
              type="button"
              role="tab"
              aria-selected={c.channel === channel}
              className={chip(c.channel === channel)}
              onClick={() => {
                if (c.channel === channel) return;
                if (cart.length > 0 && !window.confirm(t("pos.channelClearsCart"))) return;
                reset();
                setCategory(null);
                setChannel(c.channel);
              }}
            >
              {t(`menu.channels.${c.channel}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={chip(category === null)}
            onClick={() => setCategory(null)}
          >
            {t("pos.allCategories")}
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={chip(category === c.id)}
              onClick={() => setCategory(c.id)}
            >
              {named(c, locale)}
            </button>
          ))}
        </div>
        {items.length === 0 ? <p className="text-muted text-sm">{t("pos.nothingOnSale")}</p> : null}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {shown.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className="border-border bg-surface hover:border-primary flex min-h-20 w-full flex-col items-start justify-between rounded-lg border p-3 text-start"
                onClick={() => (i.groups.length > 0 ? setChoosing(i) : add(i))}
              >
                <span className="font-medium">
                  <bdi>{named(i, locale)}</bdi>
                </span>
                <span className="ltr-value text-muted text-sm tabular-nums">
                  {fmt(new Decimal(i.price))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-label={t("pos.order")}
        className="border-border bg-surface space-y-3 self-start rounded-lg border p-4 lg:sticky lg:top-4"
      >
        <h2 className="text-lg font-semibold">{t("pos.order")}</h2>
        {done ? (
          <div role="status" className="border-success/40 bg-success-surface rounded-md border p-3">
            <p className="font-medium">{t("pos.paid", { number: done.number })}</p>
            {new Decimal(done.change).gt(0) ? (
              <p className="text-2xl font-semibold">
                {t("pos.giveChange")}{" "}
                <span className="ltr-value tabular-nums">{fmt(new Decimal(done.change))}</span>
              </p>
            ) : null}
            {done.shortfalls > 0 ? (
              <p className="bg-warning-surface rounded px-2 py-1 text-sm">
                {t("pos.shortfallNote")}
              </p>
            ) : null}
            <Link
              href={`/o/${orgSlug}/pos/orders/${done.id}/receipt`}
              target="_blank"
              className="text-primary text-sm hover:underline"
            >
              {t("pos.printReceipt")}
            </Link>
          </div>
        ) : null}
        {cart.length === 0 ? (
          <p className="text-muted text-sm">{t("pos.emptyCart")}</p>
        ) : (
          <ul className="divide-border divide-y">
            {cart.map((l, index) => (
              <li key={l.key} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    <bdi>{named(l.item, locale)}</bdi>
                  </p>
                  {l.optionNames.length > 0 ? (
                    <p className="text-muted text-xs">{l.optionNames.join(" · ")}</p>
                  ) : null}
                  <p className="ltr-value text-muted text-xs tabular-nums">
                    {fmt(amounts[index].gross)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className={buttonClass("secondary")}
                    aria-label={t("pos.less", { item: named(l.item, locale) })}
                    onClick={() => changeQuantity(l.key, -1)}
                  >
                    −
                  </button>
                  <span className="w-8 text-center tabular-nums">{l.quantity}</span>
                  <button
                    type="button"
                    className={buttonClass("secondary")}
                    aria-label={t("pos.more", { item: named(l.item, locale) })}
                    onClick={() => changeQuantity(l.key, 1)}
                  >
                    +
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <dl className="border-border space-y-1 border-t pt-3 text-sm">
          {tax.gt(0) ? (
            <div className="flex justify-between">
              <dt className="text-muted">{t("pos.vat")}</dt>
              <dd className="ltr-value tabular-nums">{fmt(tax)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between text-xl font-semibold">
            <dt>{t("pos.total")}</dt>
            <dd className="ltr-value tabular-nums" data-testid="till-total">
              {fmt(total)}
            </dd>
          </div>
        </dl>
        {error ? (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        ) : null}
        {cart.length > 0 && paying === null ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={`${buttonClass("primary")} min-h-14`}
              onClick={() => setPaying("CASH")}
            >
              {t("pos.methods.CASH")}
            </button>
            <button
              type="button"
              className={`${buttonClass("primary")} min-h-14`}
              onClick={() => setPaying("CARD")}
            >
              {t("pos.methods.CARD")}
            </button>
          </div>
        ) : null}
        {paying === "CASH" && cart.length > 0 ? (
          <div className="space-y-2">
            <label htmlFor="tendered" className="block text-sm font-medium">
              {t("pos.tendered")}
            </label>
            <input
              id="tendered"
              className={inputClass}
              inputMode="decimal"
              dir="ltr"
              autoFocus
              value={tendered}
              onChange={(e) => setTendered(e.target.value.trim())}
            />
            <div className="flex flex-wrap gap-2">
              {[total, ...[5, 10, 50, 100].map((step) => total.div(step).ceil().times(step))]
                .filter((v, i, all) => all.findIndex((x) => x.equals(v)) === i)
                .map((v) => (
                  <button
                    key={v.toFixed()}
                    type="button"
                    className={buttonClass("secondary")}
                    onClick={() => setTendered(v.toFixed())}
                  >
                    <span className="ltr-value tabular-nums">{fmt(v)}</span>
                  </button>
                ))}
            </div>
            {change ? (
              <p className="text-sm">
                {t("pos.change")}{" "}
                <span className="ltr-value font-semibold tabular-nums">{fmt(change)}</span>
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                className={`${buttonClass("primary")} min-h-12 flex-1`}
                disabled={pending}
                aria-busy={pending}
                onClick={() => pay("CASH")}
              >
                {pending ? t("common.saving") : t("pos.takePayment")}
              </button>
              <button
                type="button"
                className={buttonClass("secondary")}
                onClick={() => setPaying(null)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : null}
        {paying === "CARD" && cart.length > 0 ? (
          <div className="space-y-2">
            <p className="text-muted text-sm">{t("pos.cardHint")}</p>
            <div className="flex gap-2">
              <button
                type="button"
                className={`${buttonClass("primary")} min-h-12 flex-1`}
                disabled={pending}
                aria-busy={pending}
                onClick={() => pay("CARD")}
              >
                {pending ? t("common.saving") : t("pos.cardApproved")}
              </button>
              <button
                type="button"
                className={buttonClass("secondary")}
                onClick={() => setPaying(null)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : null}
        {cart.length > 0 ? (
          <button
            type="button"
            className="text-danger text-sm hover:underline"
            onClick={() => {
              if (window.confirm(t("pos.clearConfirm"))) reset();
            }}
          >
            {t("pos.clear")}
          </button>
        ) : null}
      </section>

      {choosing ? (
        <OptionsDialog
          item={choosing}
          fmt={fmt}
          onCancel={() => setChoosing(null)}
          onAdd={(ids) => {
            add(choosing, ids);
            setChoosing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function OptionsDialog({
  item,
  fmt,
  onCancel,
  onAdd,
}: {
  item: Item;
  fmt: (d: Decimal) => string;
  onCancel: () => void;
  onAdd: (optionIds: string[]) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const ok = item.groups.every((g) => {
    const n = chosen[g.id]?.length ?? 0;
    return n >= g.minSelect && n <= g.maxSelect;
  });
  const toggle = (groupId: string, optionId: string, single: boolean) =>
    setChosen((c) => {
      const now = c[groupId] ?? [];
      if (single) return { ...c, [groupId]: now.includes(optionId) ? [] : [optionId] };
      return {
        ...c,
        [groupId]: now.includes(optionId) ? now.filter((x) => x !== optionId) : [...now, optionId],
      };
    });
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="options-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
    >
      <div className="bg-surface max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg p-4 shadow-lg">
        <h2 id="options-title" className="text-lg font-semibold">
          <bdi>{named(item, locale)}</bdi>
        </h2>
        {item.groups.map((g) => {
          const single = g.maxSelect === 1;
          return (
            <fieldset key={g.id} className="space-y-2">
              <legend className="text-sm font-medium">
                <bdi>{named(g, locale)}</bdi>{" "}
                <span className="text-muted font-normal">
                  {t("menu.selectRange", { min: g.minSelect, max: g.maxSelect })}
                </span>
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {g.options.map((o) => {
                  const on = chosen[g.id]?.includes(o.id) ?? false;
                  const full = !single && !on && (chosen[g.id]?.length ?? 0) >= g.maxSelect;
                  return (
                    <label
                      key={o.id}
                      className={`flex min-h-12 items-center justify-between gap-2 rounded-md border px-3 ${
                        on ? "border-primary" : "border-border"
                      } ${full ? "opacity-50" : ""}`}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type={single ? "radio" : "checkbox"}
                          name={`group-${g.id}`}
                          checked={on}
                          disabled={full}
                          onChange={() => toggle(g.id, o.id, single)}
                        />
                        <bdi>{named(o, locale)}</bdi>
                      </span>
                      {new Decimal(o.priceDelta).isZero() ? null : (
                        <span className="ltr-value text-muted text-sm tabular-nums">
                          {new Decimal(o.priceDelta).isNegative() ? "" : "+"}
                          {fmt(new Decimal(o.priceDelta))}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
        <div className="flex gap-2">
          <button
            type="button"
            className={`${buttonClass("primary")} min-h-12 flex-1`}
            disabled={!ok}
            onClick={() => onAdd(Object.values(chosen).flat())}
          >
            {t("pos.addToOrder")}
          </button>
          <button type="button" className={buttonClass("secondary")} onClick={onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
