"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { Decimal } from "@/lib/decimal";
import {
  addCustomerAction,
  couponAction,
  findCustomerAction,
  giftCardBalanceAction,
  sellGiftCardAction,
} from "@/app/o/[orgSlug]/pos/tables-actions";
import { promotionFor, saleMoment } from "@/modules/pos/discounts";
import { lineAmounts } from "@/modules/pos/rules";
import type { TillData } from "@/modules/pos/service";
import {
  DiscountPanel,
  discountPayload,
  priceWithDiscounts,
  type DiscountChoice,
} from "./discount-panel";
import {
  CustomerPanel,
  GiftCardPay,
  SellGiftCard,
  type TillCustomer,
  type TillGiftCard,
} from "./customer-panel";
import {
  listOrders,
  removeOrder,
  saveOrder,
  sendOrder,
  syncPending,
  type QueuedOrder,
} from "./queue";

type Channel = TillData["channels"][number]["channel"];
export type MenuItemView = TillData["channels"][number]["items"][number];
type Item = MenuItemView;
/** The last sale: recorded by the server, or kept on this device until it can be sent. */
type Done =
  | { queued: false; id: string; number: string; change: string; shortfalls: number }
  | { queued: true; change: string };

const SYNC_EVERY_MS = 15_000;
const CLOCK_EVERY_MS = 30_000;
const now = () => new Date();
const REFRESH_MENU_EVERY_MS = 5 * 60_000;

interface CartLine {
  key: string;
  item: Item;
  quantity: number;
  optionIds: string[];
  optionNames: string[];
  unit: Decimal;
}

export const named = (x: { name: string; nameAr: string | null }, locale: string) =>
  (locale === "ar" && x.nameAr) || x.name;

/**
 * The cashier screen (ADR-059, ADR-060). Prices, options and VAT come from
 * the server; the total shown is the one the server recomputes and checks.
 * Every paid order is saved on the device first and sent at once; without a
 * connection it waits in the queue and is sent later, oldest first. The order
 * id from the device makes every resend safe.
 */
export function Till({ orgSlug, data }: { orgSlug: string; data: TillData }) {
  const t = useTranslations();
  const router = useRouter();
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
  const [paying, setPaying] = useState<"CASH" | "CARD" | "GIFT_CARD" | null>(null);
  const [tendered, setTendered] = useState("");
  // From the terminal slip (all optional): scheme, approval code, last 4 digits, tip.
  const noCard = { scheme: "", approvalCode: "", last4: "", tip: "" };
  const [card, setCard] = useState(noCard);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [pending, startTransition] = useTransition();
  const orderId = useRef<string | null>(null);
  const [queue, setQueue] = useState<QueuedOrder[]>([]);
  const [online, setOnline] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [discount, setDiscount] = useState<DiscountChoice>(null);
  const [customer, setCustomer] = useState<TillCustomer | null>(null);
  const [gift, setGift] = useState<TillGiftCard | null>(null);
  // Promotions depend on the time of day: re-evaluated every half minute and at payment.
  const [clock, setClock] = useState(now);
  const register = data.register.id;
  const cashier = data.cashierUserId;

  const reloadQueue = useCallback(async () => {
    try {
      setQueue(await listOrders(register, cashier));
    } catch {
      setQueue([]);
    }
  }, [register, cashier]);

  const sync = useCallback(async () => {
    try {
      await syncPending(register, cashier, (s) => setSignedOut(s.signedOut));
    } catch {
      // Storage unavailable: nothing is queued on this device.
    }
    await reloadQueue();
  }, [register, cashier, reloadQueue]);

  // Send what is waiting now, every few seconds, and as soon as the connection is back.
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    const first = window.setTimeout(() => {
      update();
      void sync();
    }, 0);
    const timer = window.setInterval(() => void sync(), SYNC_EVERY_MS);
    const back = () => {
      update();
      void sync();
    };
    window.addEventListener("online", back);
    window.addEventListener("offline", update);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("online", back);
      window.removeEventListener("offline", update);
    };
  }, [sync]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), CLOCK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  /** The cart as the server prices it at `at`: promotions, then the order discount (ADR-067). */
  const priceAt = (at: Date) => {
    const moment = saleMoment(channel, data.timeZone, at);
    const promotions = data.promotions.map((p) => ({ ...p, percent: new Decimal(p.percent) }));
    return priceWithDiscounts(
      cart.map((l) => {
        const rate = l.item.taxRate === null ? null : new Decimal(l.item.taxRate);
        const promo = promotionFor(
          { id: l.item.id, categoryId: l.item.category.id },
          moment,
          promotions,
        );
        return {
          gross: lineAmounts(
            l.unit,
            new Decimal(l.quantity),
            l.item.includesTax,
            rate,
            data.currency,
          ).gross,
          rate,
          promoPercent: promo?.percent ?? null,
        };
      }),
      discount,
      data.currency,
    );
  };
  const priced = priceAt(clock);
  const amounts = priced.lines;
  const { total, tax } = priced;
  // A gift card pays what it can; the rest is paid in cash or by card (ADR-068).
  const giftAmount = gift ? Decimal.min(new Decimal(gift.balance), total) : new Decimal(0);
  const due = total.minus(giftAmount);
  const tenderedValue = /^\d+(\.\d+)?$/.test(tendered) ? new Decimal(tendered) : null;
  const change = tenderedValue && tenderedValue.gte(due) ? tenderedValue.minus(due) : null;

  const reset = () => {
    setCart([]);
    setPaying(null);
    setTendered("");
    setCard(noCard);
    setDiscount(null);
    setCustomer(null);
    setGift(null);
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

  const pay = (method: "CASH" | "CARD" | null) => {
    const at = new Date();
    if (!priceAt(at).total.equals(total)) {
      // A promotion started or ended since the total was shown.
      setClock(at);
      setError(t("pos.promotionsChanged"));
      return;
    }
    if (method === "CASH" && (!tenderedValue || tenderedValue.lt(due))) {
      setError(t("pos.tenderedTooLow"));
      return;
    }
    orderId.current ??= crypto.randomUUID();
    const payload = {
      orderId: orderId.current,
      registerId: data.register.id,
      shiftId: data.shift?.id,
      menuAsOf: data.menuAsOf,
      cashierUserId: data.cashierUserId,
      orderedAt: at.toISOString(),
      channel,
      lines: cart.map((l) => ({
        itemId: l.item.id,
        quantity: String(l.quantity),
        optionIds: l.optionIds,
      })),
      ...discountPayload(discount),
      ...(customer ? { customerId: customer.id } : {}),
      // An order discounted to nothing takes no payment.
      payments: [
        gift && giftAmount.gt(0)
          ? { method: "GIFT_CARD", amount: giftAmount.toFixed(), giftCardCode: gift.code }
          : null,
        method === null || due.isZero()
          ? null
          : method === "CASH"
            ? { method, amount: due.toFixed(), tendered: tenderedValue!.toFixed() }
            : {
                method,
                amount: due.toFixed(),
                ...(card.scheme ? { cardScheme: card.scheme } : {}),
                ...(card.approvalCode.trim() ? { approvalCode: card.approvalCode.trim() } : {}),
                ...(card.last4 ? { cardLast4: card.last4 } : {}),
                ...(/^\d+(\.\d+)?$/.test(card.tip) && Number(card.tip) > 0
                  ? { tip: card.tip }
                  : {}),
              },
      ].filter((p) => p !== null),
      expectedTotal: total.toFixed(),
    };
    const queued: QueuedOrder = {
      orderId: payload.orderId,
      orgSlug,
      registerId: data.register.id,
      cashierUserId: data.cashierUserId,
      payload,
      total: total.toFixed(),
      takenAt: payload.orderedAt,
      status: "pending",
      attempts: 0,
    };
    const changeGiven = method === "CASH" ? tenderedValue!.minus(due).toFixed() : "0";
    // Gift cards, points and coupons are checked by the server now: such an order is never queued.
    const onlineOnly = gift !== null || discount?.type === "points" || discount?.type === "coupon";
    setError(null);
    startTransition(async () => {
      let stored = !onlineOnly;
      if (stored)
        try {
          await saveOrder(queued);
        } catch {
          stored = false; // No device storage (private window): send directly only.
        }
      const r = await sendOrder(queued);
      if (r.outcome === "recorded") {
        if (stored) await removeOrder(queued.orderId);
        reset();
        setDone({ queued: false, ...r });
      } else if (r.outcome === "refused") {
        // Refused at once: nothing was recorded; the cashier corrects the order.
        if (stored) await removeOrder(queued.orderId);
        setError(r.error);
      } else if (stored) {
        reset();
        setDone({ queued: true, change: changeGiven });
        if (r.outcome === "signedOut") setSignedOut(true);
      } else setError(t("pos.retry"));
      await reloadQueue();
    });
  };

  // Pick up price and menu changes while idle (the screen then prices with the new menu).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (cart.length === 0 && navigator.onLine && !choosing) router.refresh();
    }, REFRESH_MENU_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [cart.length, choosing, router]);

  const waiting = queue.filter((o) => o.status === "pending");
  const refused = queue.filter((o) => o.status === "refused");

  if (!data.shift)
    return (
      <p role="alert" className="text-danger">
        {t("pos.noOpenShift")}
      </p>
    );

  const shown = category ? items.filter((i) => i.category.id === category) : items;
  const inCart = (itemId: string) =>
    cart.reduce((n, l) => (l.item.id === itemId ? n + l.quantity : n), 0);
  const chip = (active: boolean) =>
    `min-h-11 rounded-full border px-4 text-sm font-medium ${
      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface"
    }`;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem] xl:grid-cols-[1fr_24rem]">
      <SyncStatus
        online={online}
        signedOut={signedOut}
        waiting={waiting.length}
        refused={refused}
        fmt={fmt}
        onRetry={async (o) => {
          await saveOrder({ ...o, status: "pending", error: undefined });
          await sync();
        }}
        onDiscard={async (o) => {
          if (!window.confirm(t("pos.discardConfirm"))) return;
          await removeOrder(o.orderId);
          await reloadQueue();
        }}
        onSync={() => void sync()}
      />
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
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
          {shown.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className="border-border bg-surface hover:border-primary active:bg-surface-muted relative flex min-h-28 w-full touch-manipulation flex-col items-start justify-between rounded-xl border p-3.5 text-start shadow-sm transition active:scale-[0.97]"
                onClick={() => (i.groups.length > 0 ? setChoosing(i) : add(i))}
              >
                <span className="pe-7 text-base leading-snug font-semibold">
                  <bdi>{named(i, locale)}</bdi>
                </span>
                <span className="ltr-value text-primary text-base font-bold tabular-nums">
                  {fmt(new Decimal(i.price))}
                </span>
                {inCart(i.id) > 0 ? (
                  // How many are in the order already; not part of the button's name.
                  <span
                    aria-hidden="true"
                    className="bg-primary text-primary-foreground absolute end-2 top-2 flex size-6 items-center justify-center rounded-full text-xs font-bold tabular-nums"
                  >
                    {inCart(i.id)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-label={t("pos.order")}
        className="border-border bg-surface space-y-3 self-start rounded-xl border p-4 shadow-sm lg:sticky lg:top-20"
      >
        <h2 className="text-lg font-semibold">{t("pos.order")}</h2>
        {done ? (
          <div role="status" className="border-success/40 bg-success-surface rounded-md border p-3">
            <p className="font-medium">
              {done.queued ? t("pos.savedOnDevice") : t("pos.paid", { number: done.number })}
            </p>
            {new Decimal(done.change).gt(0) ? (
              <p className="text-2xl font-semibold">
                {t("pos.giveChange")}{" "}
                <span className="ltr-value tabular-nums">{fmt(new Decimal(done.change))}</span>
              </p>
            ) : null}
            {!done.queued && done.shortfalls > 0 ? (
              <p className="bg-warning-surface rounded px-2 py-1 text-sm">
                {t("pos.shortfallNote")}
              </p>
            ) : null}
            {done.queued ? (
              <p className="text-muted text-sm">{t("pos.receiptAfterSync")}</p>
            ) : (
              <Link
                href={`/o/${orgSlug}/pos/orders/${done.id}/receipt`}
                target="_blank"
                className="text-primary text-sm hover:underline"
              >
                {t("pos.printReceipt")}
              </Link>
            )}
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
                    className={`${buttonClass("secondary")} size-11 touch-manipulation p-0 text-lg`}
                    aria-label={t("pos.less", { item: named(l.item, locale) })}
                    onClick={() => changeQuantity(l.key, -1)}
                  >
                    −
                  </button>
                  <span className="w-8 text-center tabular-nums">{l.quantity}</span>
                  <button
                    type="button"
                    className={`${buttonClass("secondary")} size-11 touch-manipulation p-0 text-lg`}
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
        {cart.length > 0 ? (
          <CustomerPanel
            online={online}
            currency={data.currency}
            customer={customer}
            onCustomer={(c) => {
              setCustomer(c);
              orderId.current = null;
            }}
            loyalty={data.loyalty}
            choice={discount}
            onChoice={(c) => {
              setDiscount(c);
              orderId.current = null;
            }}
            find={(phone) => findCustomerAction(orgSlug, phone)}
            add={(input) => addCustomerAction(orgSlug, input)}
            fmt={fmt}
          />
        ) : null}
        {cart.length > 0 && discount?.type !== "points" ? (
          <DiscountPanel
            idPrefix="till"
            canDiscount={data.canDiscount}
            choice={discount}
            onChange={(c) => {
              setDiscount(c);
              orderId.current = null;
            }}
            lookup={(code) => couponAction(orgSlug, data.register.id, code)}
          />
        ) : null}
        <dl className="border-border space-y-1 border-t pt-3 text-sm">
          {priced.promoDiscount.gt(0) ? (
            <div className="flex justify-between">
              <dt className="text-muted">{t("pos.promotions")}</dt>
              <dd className="ltr-value tabular-nums" data-testid="till-promotions">
                −{fmt(priced.promoDiscount)}
              </dd>
            </div>
          ) : null}
          {priced.orderDiscount.gt(0) ? (
            <div className="flex justify-between">
              <dt className="text-muted">{t("pos.discount")}</dt>
              <dd className="ltr-value tabular-nums" data-testid="till-discount">
                −{fmt(priced.orderDiscount)}
              </dd>
            </div>
          ) : null}
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
          {gift ? (
            <>
              <div className="flex justify-between">
                <dt className="text-muted">
                  {t("pos.giftCardEnding", { last4: gift.last4 })}{" "}
                  <button
                    type="button"
                    className="text-danger hover:underline"
                    onClick={() => setGift(null)}
                  >
                    {t("pos.removeDiscount")}
                  </button>
                </dt>
                <dd className="ltr-value tabular-nums">−{fmt(giftAmount)}</dd>
              </div>
              <div className="flex justify-between font-semibold">
                <dt>{t("pos.toPay")}</dt>
                <dd className="ltr-value tabular-nums" data-testid="till-due">
                  {fmt(due)}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
        {error ? (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        ) : null}
        {cart.length > 0 && paying === null && gift && due.isZero() && !total.isZero() ? (
          <button
            type="button"
            className={`${buttonClass("primary")} min-h-14 w-full`}
            disabled={pending}
            aria-busy={pending}
            onClick={() => pay(null)}
          >
            {pending ? t("common.saving") : t("pos.completeWithGiftCard")}
          </button>
        ) : null}
        {cart.length > 0 && paying === null && total.isZero() ? (
          <button
            type="button"
            className={`${buttonClass("primary")} min-h-14 w-full`}
            disabled={pending}
            aria-busy={pending}
            onClick={() => pay(null)}
          >
            {pending ? t("common.saving") : t("pos.nothingToPayComplete")}
          </button>
        ) : null}
        {cart.length > 0 && paying === null && !due.isZero() ? (
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
            {gift ? null : (
              <button
                type="button"
                className={`${buttonClass("secondary")} col-span-2`}
                onClick={() => setPaying("GIFT_CARD")}
              >
                {t("pos.methods.GIFT_CARD")}
              </button>
            )}
          </div>
        ) : null}
        {paying === "GIFT_CARD" && cart.length > 0 ? (
          <div className="space-y-2">
            <GiftCardPay
              online={online}
              check={(code) => giftCardBalanceAction(orgSlug, code)}
              onApply={(g) => {
                setGift(g);
                setPaying(null);
                orderId.current = null;
              }}
            />
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => setPaying(null)}
            >
              {t("common.cancel")}
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
              {[due, ...[5, 10, 50, 100].map((step) => due.div(step).ceil().times(step))]
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
            <details className="text-sm">
              <summary className="cursor-pointer">{t("pos.cardDetails")}</summary>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="card-scheme" className="mb-1 block">
                    {t("pos.cardScheme")}
                  </label>
                  <select
                    id="card-scheme"
                    className={inputClass}
                    value={card.scheme}
                    onChange={(e) => setCard((c) => ({ ...c, scheme: e.target.value }))}
                  >
                    <option value="">—</option>
                    {(["MADA", "VISA", "MASTERCARD", "AMEX", "OTHER"] as const).map((x) => (
                      <option key={x} value={x}>
                        {t(`pos.cardSchemes.${x}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="card-approval" className="mb-1 block">
                    {t("pos.approvalCode")}
                  </label>
                  <input
                    id="card-approval"
                    className={inputClass}
                    dir="ltr"
                    maxLength={12}
                    value={card.approvalCode}
                    onChange={(e) => setCard((c) => ({ ...c, approvalCode: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="card-last4" className="mb-1 block">
                    {t("pos.cardLast4")}
                  </label>
                  <input
                    id="card-last4"
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    maxLength={4}
                    value={card.last4}
                    onChange={(e) =>
                      setCard((c) => ({
                        ...c,
                        last4: e.target.value.replace(/\D/g, "").slice(0, 4),
                      }))
                    }
                  />
                </div>
                <div>
                  <label htmlFor="card-tip" className="mb-1 block">
                    {t("pos.tip")}
                  </label>
                  <input
                    id="card-tip"
                    className={inputClass}
                    dir="ltr"
                    inputMode="decimal"
                    value={card.tip}
                    onChange={(e) => setCard((c) => ({ ...c, tip: e.target.value.trim() }))}
                  />
                </div>
              </div>
            </details>
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
        {cart.length === 0 ? (
          <SellGiftCard
            online={online}
            sell={(input) =>
              sellGiftCardAction(orgSlug, { ...(input as object), registerId: data.register.id })
            }
            fmt={fmt}
          />
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

export function OptionsDialog({
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

/** Connection and queue state, and orders the server refused (with their reason). */
function SyncStatus({
  online,
  signedOut,
  waiting,
  refused,
  fmt,
  onRetry,
  onDiscard,
  onSync,
}: {
  online: boolean;
  signedOut: boolean;
  waiting: number;
  refused: QueuedOrder[];
  fmt: (d: Decimal) => string;
  onRetry: (o: QueuedOrder) => Promise<void>;
  onDiscard: (o: QueuedOrder) => Promise<void>;
  onSync: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-2 lg:col-span-2" data-testid="sync-status">
      <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-3 py-1 font-medium ${
            online ? "bg-success-surface text-success" : "bg-warning-surface"
          }`}
        >
          {online ? t("pos.online") : t("pos.offline")}
        </span>
        {waiting > 0 ? (
          <>
            <span>{t("pos.waitingToSync", { count: waiting })}</span>
            <button type="button" className="text-primary hover:underline" onClick={onSync}>
              {t("pos.syncNow")}
            </button>
          </>
        ) : (
          <span className="text-muted">{t("pos.allSynced")}</span>
        )}
      </div>
      {signedOut && waiting > 0 ? (
        <p role="alert" className="bg-warning-surface rounded px-3 py-2 text-sm">
          {t("pos.signInToSync")}
        </p>
      ) : null}
      {refused.length > 0 ? (
        <div role="alert" className="border-danger/40 bg-danger-surface rounded-md border p-3">
          <p className="text-danger text-sm font-medium">
            {t("pos.refusedOrders", { count: refused.length })}
          </p>
          <ul className="mt-2 space-y-2 text-sm">
            {refused.map((o) => (
              <li key={o.orderId} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="ltr-value tabular-nums">{fmt(new Decimal(o.total))}</span>
                  {" · "}
                  <span className="ltr-value">{new Date(o.takenAt).toLocaleTimeString()}</span>
                  {" · "}
                  {o.error}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    className={buttonClass("secondary")}
                    onClick={() => void onRetry(o)}
                  >
                    {t("pos.retrySend")}
                  </button>
                  <button
                    type="button"
                    className={buttonClass("danger")}
                    onClick={() => void onDiscard(o)}
                  >
                    {t("pos.discard")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
