"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { Decimal } from "@/lib/decimal";
import { lineAmounts } from "@/modules/pos/rules";
import type { PublicMenu } from "@/modules/pos/ordering";
import type { GuestOrderResult } from "@/app/order/actions";
import { named, OptionsDialog, type MenuItemView } from "./till";

interface Line {
  key: string;
  item: MenuItemView;
  quantity: number;
  optionIds: string[];
  optionNames: string[];
  unit: Decimal;
}

const KIOSK_RESET_MS = 20_000;

/**
 * The guest's ordering page (ADR-070): the web site for pick-up, or a
 * self-order kiosk (large buttons, no phone, back to the start after each
 * order). The total shown is the server's prices; payment is at the counter.
 */
export function GuestOrdering({
  menu,
  mode,
  place,
}: {
  menu: PublicMenu;
  mode: "WEB" | "KIOSK";
  place: (input: unknown) => Promise<GuestOrderResult>;
}) {
  const t = useTranslations("ordering");
  const locale = useLocale();
  const money = useMemo(
    () =>
      new Intl.NumberFormat(`${locale}-u-nu-latn`, { style: "currency", currency: menu.currency }),
    [locale, menu.currency],
  );
  const fmt = (d: Decimal) => money.format(d.toString() as unknown as number);
  const [channel, setChannel] = useState(menu.channels[0]?.channel ?? "TAKEAWAY");
  const items = menu.channels.find((c) => c.channel === channel)?.items ?? [];
  const categories = [...new Map(items.map((i) => [i.category.id, i.category])).values()];
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [choosing, setChoosing] = useState<MenuItemView | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<{ number: string; guestToken: string } | null>(null);
  const [pending, start] = useTransition();
  const key = useRef<string | null>(null);
  const kiosk = mode === "KIOSK";

  const total = cart.reduce(
    (a, l) =>
      a.plus(
        lineAmounts(
          l.unit,
          new Decimal(l.quantity),
          l.item.includesTax,
          l.item.taxRate === null ? null : new Decimal(l.item.taxRate),
          menu.currency,
        ).gross,
      ),
    new Decimal(0),
  );

  // A kiosk goes back to the start for the next guest.
  const nextGuest = () => {
    setPlaced(null);
    setName("");
    setPhone("");
    setNote("");
    setCategory(null);
  };
  useEffect(() => {
    if (!kiosk || !placed) return;
    const timer = window.setTimeout(nextGuest, KIOSK_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [kiosk, placed]);

  const add = (item: MenuItemView, optionIds: string[] = []) => {
    const options = item.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id));
    const unit = options.reduce((a, o) => a.plus(o.priceDelta), new Decimal(item.price));
    const k = `${item.id}:${[...optionIds].sort().join(",")}`;
    key.current = null;
    setCart((c) =>
      c.some((l) => l.key === k)
        ? c.map((l) => (l.key === k ? { ...l, quantity: Math.min(20, l.quantity + 1) } : l))
        : [
            ...c,
            {
              key: k,
              item,
              quantity: 1,
              optionIds,
              optionNames: options.map((o) => named(o, locale)),
              unit,
            },
          ],
    );
  };
  const change = (k: string, delta: number) => {
    key.current = null;
    setCart((c) =>
      c
        .map((l) => (l.key === k ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  };

  const submit = () => {
    if (!name.trim()) return setError(t("nameRequired"));
    if (!kiosk && !phone.trim()) return setError(t("phoneRequired"));
    key.current ??= crypto.randomUUID();
    setError(null);
    start(async () => {
      const r = await place({
        key: key.current,
        channel,
        name,
        phone,
        note: note || undefined,
        lines: cart.map((l) => ({
          itemId: l.item.id,
          quantity: l.quantity,
          optionIds: l.optionIds,
        })),
      });
      if (!r.ok) return setError(r.error);
      key.current = null;
      setPlaced({ number: r.number, guestToken: r.guestToken });
      setCart([]);
    });
  };

  const big = kiosk ? "min-h-16 text-lg" : "min-h-11";
  const chip = (active: boolean) =>
    `${big} rounded-full border px-4 font-medium ${
      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface"
    }`;

  if (placed)
    return (
      <div
        role="status"
        className="border-success/40 bg-success-surface mx-auto max-w-lg space-y-3 rounded-lg border p-6 text-center"
      >
        <p className="text-lg">{t("thanks", { name })}</p>
        <p className="text-3xl font-bold" data-testid="guest-order-number">
          {placed.number}
        </p>
        <p>{t("payAtCounter")}</p>
        {kiosk ? (
          <button type="button" className={buttonClass("primary")} onClick={nextGuest}>
            {t("newOrder")}
          </button>
        ) : (
          <Link href={`/order/status/${placed.guestToken}`} className="text-primary underline">
            {t("followOrder")}
          </Link>
        )}
      </div>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
      <section aria-label={t("menu")} className="space-y-3">
        {menu.channels.length > 1 ? (
          <div role="tablist" aria-label={t("howToEat")} className="flex flex-wrap gap-2">
            {menu.channels.map((c) => (
              <button
                key={c.channel}
                type="button"
                role="tab"
                aria-selected={c.channel === channel}
                className={chip(c.channel === channel)}
                onClick={() => {
                  setChannel(c.channel);
                  setCart([]);
                  setCategory(null);
                }}
              >
                {t(`channels.${c.channel}`)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={chip(category === null)}
            onClick={() => setCategory(null)}
          >
            {t("all")}
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
        <ul
          className={`grid gap-2 ${kiosk ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 xl:grid-cols-4"}`}
        >
          {(category ? items.filter((i) => i.category.id === category) : items).map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className={`border-border bg-surface hover:border-primary flex w-full flex-col items-start justify-between rounded-lg border p-3 text-start ${kiosk ? "min-h-28 text-lg" : "min-h-20"}`}
                onClick={() => (i.groups.length > 0 ? setChoosing(i) : add(i))}
              >
                <span className="font-medium">
                  <bdi>{named(i, locale)}</bdi>
                </span>
                <span className="ltr-value text-muted tabular-nums">
                  {fmt(new Decimal(i.price))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section
        aria-label={t("yourOrder")}
        className="border-border bg-surface space-y-3 self-start rounded-lg border p-4 lg:sticky lg:top-4"
      >
        <h2 className="text-lg font-semibold">{t("yourOrder")}</h2>
        {cart.length === 0 ? <p className="text-muted text-sm">{t("empty")}</p> : null}
        <ul className="divide-border divide-y">
          {cart.map((l) => (
            <li key={l.key} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="font-medium">
                  <bdi>{named(l.item, locale)}</bdi>
                </p>
                {l.optionNames.length > 0 ? (
                  <p className="text-muted text-xs">{l.optionNames.join(" · ")}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={buttonClass("secondary")}
                  aria-label={t("less", { item: l.item.name })}
                  onClick={() => change(l.key, -1)}
                >
                  −
                </button>
                <span className="w-8 text-center tabular-nums">{l.quantity}</span>
                <button
                  type="button"
                  className={buttonClass("secondary")}
                  aria-label={t("more", { item: l.item.name })}
                  onClick={() => change(l.key, 1)}
                >
                  +
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex justify-between text-xl font-semibold">
          <span>{t("total")}</span>
          <span className="ltr-value tabular-nums" data-testid="guest-total">
            {fmt(total)}
          </span>
        </div>
        {cart.length > 0 ? (
          <div className="space-y-2">
            <div>
              <label htmlFor="guest-name" className="mb-1 block text-sm font-medium">
                {t("yourName")}
              </label>
              <input
                id="guest-name"
                className={inputClass}
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="given-name"
              />
            </div>
            {kiosk ? null : (
              <div>
                <label htmlFor="guest-phone" className="mb-1 block text-sm font-medium">
                  {t("yourPhone")}
                </label>
                <input
                  id="guest-phone"
                  className={inputClass}
                  inputMode="tel"
                  dir="ltr"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                />
                <p className="text-muted mt-1 text-xs">{t("phoneUse")}</p>
              </div>
            )}
            <div>
              <label htmlFor="guest-note" className="mb-1 block text-sm font-medium">
                {t("note")}
              </label>
              <input
                id="guest-note"
                className={inputClass}
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-danger text-sm">
                {error}
              </p>
            ) : null}
            <button
              type="button"
              className={`${buttonClass("primary")} ${big} w-full`}
              disabled={pending}
              aria-busy={pending}
              onClick={submit}
            >
              {pending ? t("placing") : t("placeOrder")}
            </button>
            <p className="text-muted text-xs">{t("payAtCounterHint")}</p>
          </div>
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
