"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MenuBoard } from "@/components/pos/menu-board";
import { CameraScanner, cameraScanningAvailable } from "@/components/scan/scan-input";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { Decimal } from "@/lib/decimal";
import { matchBarcode } from "@/modules/pos/barcode-match";
import { inWindow } from "@/modules/pos/board-rules";
import { promotionFor, saleMoment } from "@/modules/pos/discounts";
import { lineAmounts } from "@/modules/pos/rules";
import type { SimulatorData } from "@/modules/pos/simulator";
import {
  sessionCsv,
  summarize,
  tender,
  type SimPayment,
  type SimSale,
} from "@/modules/pos/simulator-rules";
import { priceWithDiscounts } from "./discount-panel";
import { named, OptionsDialog } from "./till";

type Item = SimulatorData["channels"][number]["items"][number];
interface Line {
  key: string;
  item: Item;
  quantity: number;
  optionIds: string[];
  optionNames: string[];
  unit: Decimal;
  /** How many of the quantity were scanned (the rest were punched or added with +). */
  scannedQty: number;
}

const noSubscribe = () => () => {};
const chip = (on: boolean) =>
  `rounded-full border px-3 py-1.5 text-sm ${on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface hover:bg-surface-muted"}`;

/**
 * The POS simulator (ADR-135): the branch's live menu, prices, options,
 * VAT, promotions and barcodes, for practising and testing sales by
 * punching or scanning, and for previewing menu boards at any time of day.
 * Nothing leaves this browser: no order, payment, stock, shift or ZATCA
 * document is created.
 */
export function PosSimulator({ data, clock }: { data: SimulatorData; clock: string }) {
  const t = useTranslations("simulator");
  const tm = useTranslations("menu");
  const locale = useLocale();
  const money = useMemo(
    () =>
      new Intl.NumberFormat(`${locale}-u-nu-latn`, { style: "currency", currency: data.currency }),
    [locale, data.currency],
  );
  const fmt = (d: Decimal | string) => money.format(d.toString() as unknown as number);
  const [tab, setTab] = useState<"SALE" | "BOARD" | "SESSION">("SALE");

  // ── Sale ──
  const channels = data.channels.filter((c) => c.items.length > 0);
  const [channel, setChannel] = useState(channels[0]?.channel ?? "DINE_IN");
  const items = data.channels.find((c) => c.channel === channel)?.items ?? [];
  const categories = [...new Map(items.map((i) => [i.category.id, i.category])).values()];
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [choosing, setChoosing] = useState<{ item: Item; scanned: boolean } | null>(null);
  const [scan, setScan] = useState("");
  const [virtualCode, setVirtualCode] = useState("");
  const [camera, setCamera] = useState(false);
  // Camera scanning needs the browser's BarcodeDetector; false while rendering on the server.
  const canCamera = useSyncExternalStore(noSubscribe, cameraScanningAvailable, () => false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [testAt, setTestAt] = useState("");
  const [discountKind, setDiscountKind] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [discountValue, setDiscountValue] = useState("");
  const [payment, setPayment] = useState<SimPayment>("CASH");
  const [tendered, setTendered] = useState("");
  const [cardPart, setCardPart] = useState("");
  const [receipt, setReceipt] = useState<SimSale | null>(null);
  const [sales, setSales] = useState<SimSale[]>([]);

  const add = (item: Item, optionIds: string[] = [], scanned = false) => {
    const options = item.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id));
    const unit = options.reduce((a, o) => a.plus(o.priceDelta), new Decimal(item.price));
    const key = `${item.id}:${[...optionIds].sort().join(",")}`;
    setReceipt(null);
    setCart((c) => {
      const existing = c.find((l) => l.key === key);
      if (existing)
        return c.map((l) =>
          l.key === key
            ? { ...l, quantity: l.quantity + 1, scannedQty: l.scannedQty + (scanned ? 1 : 0) }
            : l,
        );
      return [
        ...c,
        {
          key,
          item,
          quantity: 1,
          optionIds,
          optionNames: options.map((o) => named(o, locale)),
          unit,
          scannedQty: scanned ? 1 : 0,
        },
      ];
    });
  };
  const pick = (item: Item, scanned: boolean) =>
    item.groups.length > 0 ? setChoosing({ item, scanned }) : add(item, [], scanned);
  const scanned = (code: string) => {
    const value = code.trim();
    if (!value) return;
    const item = matchBarcode(items, value);
    if (!item) {
      setMessage({ tone: "error", text: t("scanNotFound", { code: value }) });
      return;
    }
    setMessage({ tone: "ok", text: t("scanned", { code: value, name: named(item, locale) }) });
    pick(item, true);
  };

  // Priced as the till prices it: promotions at the test time, then the order discount.
  const at = testAt ? new Date(testAt) : new Date();
  const promotions = data.promotions.map((p) => ({ ...p, percent: new Decimal(p.percent) }));
  const moment = saleMoment(channel, data.timeZone, at);
  const discountChoice =
    data.canDiscount && /^\d+(\.\d+)?$/.test(discountValue) && Number(discountValue) > 0
      ? {
          type: "manual" as const,
          kind: discountKind,
          value: discountValue,
          reason: "Simulation",
        }
      : null;
  const priced = priceWithDiscounts(
    cart.map((l) => {
      const rate = l.item.taxRate === null ? null : new Decimal(l.item.taxRate);
      const promo = promotionFor(
        { id: l.item.id, categoryId: l.item.category.id },
        moment,
        promotions,
      );
      return {
        gross: lineAmounts(l.unit, new Decimal(l.quantity), l.item.includesTax, rate, data.currency)
          .gross,
        rate,
        promoPercent: promo?.percent ?? null,
      };
    }),
    discountChoice,
    data.currency,
  );
  const listTotal = cart.reduce((a, l) => a.plus(l.unit.times(l.quantity)), new Decimal(0));
  const savings = Decimal.max(listTotal.minus(priced.total), new Decimal(0));

  const complete = () => {
    const r = tender(priced.total, payment, { tendered, cardPart });
    if (!r.ok) {
      setMessage({ tone: "error", text: t(`problems.${r.problem as "SIM_TENDERED_TOO_LOW"}`) });
      return;
    }
    const scannedCount = cart.reduce((a, l) => a + l.scannedQty, 0);
    const quantity = cart.reduce((a, l) => a + l.quantity, 0);
    const sale: SimSale = {
      number: (sales.at(-1)?.number ?? 0) + 1,
      at: at.toISOString(),
      channel,
      entry: scannedCount === 0 ? "PUNCH" : scannedCount === quantity ? "SCAN" : "MIXED",
      lines: cart.map((l, i) => ({
        itemId: l.item.id,
        name:
          named(l.item, locale) + (l.optionNames.length ? ` (${l.optionNames.join(", ")})` : ""),
        quantity: l.quantity,
        gross: priced.lines[i].gross.toFixed(2),
        tax: priced.lines[i].tax.toFixed(2),
      })),
      total: priced.total.toFixed(2),
      tax: priced.tax.toFixed(2),
      discount: savings.toFixed(2),
      payment,
      cash: r.cash.toFixed(2),
      card: r.card.toFixed(2),
      change: r.change.toFixed(2),
    };
    setSales((s) => [...s, sale]);
    setReceipt(sale);
    setCart([]);
    setTendered("");
    setCardPart("");
    setDiscountValue("");
    setMessage(null);
  };

  const summary = summarize(sales);
  const download = () => {
    const blob = new Blob([sessionCsv(sales)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pos-simulation-${data.branch.code}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Board preview ──
  const [boardId, setBoardId] = useState(data.boards[0]?.id ?? "");
  const [boardAt, setBoardAt] = useState(clock);
  const board = data.boards.find((b) => b.id === boardId) ?? null;
  const boardItems = board
    ? (
        data.channels.find((c) => board.channels.includes(c.channel) && c.items.length > 0)
          ?.items ?? []
      )
        .filter((i) => inWindow(boardAt || "00:00", i.category.boardFrom, i.category.boardTo))
        .map((i) => ({
          id: i.id,
          name: i.name,
          nameAr: i.nameAr,
          price: i.price,
          photos: i.photos,
          category: { id: i.category.id, name: i.category.name, nameAr: i.category.nameAr },
        }))
    : [];
  const withBarcodes = items.filter((i) => i.barcodes.length > 0);

  return (
    <div className="space-y-4">
      <p
        role="note"
        className="border-warning bg-warning-surface rounded-md border px-3 py-2 text-sm font-medium"
        data-testid="simulation-banner"
      >
        {t("banner")}
      </p>
      <div role="tablist" className="flex flex-wrap gap-2">
        {(["SALE", "BOARD", "SESSION"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={chip(tab === k)}
            onClick={() => setTab(k)}
          >
            {t(`tabs.${k}`)}
            {k === "SESSION" && summary.sales > 0 ? ` (${summary.sales})` : ""}
          </button>
        ))}
      </div>

      {tab === "SALE" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
          <section className="space-y-3" aria-label={t("items")}>
            <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("channel")}>
              {channels.map((c) => (
                <button
                  key={c.channel}
                  type="button"
                  role="tab"
                  aria-selected={c.channel === channel}
                  className={chip(c.channel === channel)}
                  onClick={() => {
                    if (c.channel === channel) return;
                    setCart([]);
                    setCategory(null);
                    setChannel(c.channel);
                  }}
                >
                  {tm(`channels.${c.channel}`)}
                </button>
              ))}
            </div>
            <div className="border-border bg-surface space-y-2 rounded-xl border p-3">
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  scanned(scan);
                  setScan("");
                }}
              >
                <label className="text-sm">
                  <span className="mb-1 block font-medium">{t("scan")}</span>
                  <input
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    placeholder={t("scanPlaceholder")}
                    autoComplete="off"
                    dir="ltr"
                    className={`${inputClass} w-56`}
                  />
                </label>
                <button type="submit" className={buttonClass("secondary")}>
                  {t("scanAdd")}
                </button>
                {canCamera ? (
                  <button
                    type="button"
                    className={buttonClass("secondary")}
                    onClick={() => setCamera(true)}
                  >
                    {t("camera")}
                  </button>
                ) : null}
              </form>
              {withBarcodes.length > 0 ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">{t("virtualScanner")}</span>
                    <select
                      value={virtualCode}
                      onChange={(e) => setVirtualCode(e.target.value)}
                      className={`${inputClass} w-72`}
                    >
                      <option value="">{t("chooseBarcode")}</option>
                      {withBarcodes.flatMap((i) =>
                        i.barcodes.map((b) => (
                          <option key={`${i.id}:${b}`} value={b}>
                            {named(i, locale)} — {b}
                          </option>
                        )),
                      )}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={buttonClass("secondary")}
                    disabled={!virtualCode}
                    onClick={() => scanned(virtualCode)}
                  >
                    {t("beep")}
                  </button>
                </div>
              ) : (
                <p className="text-muted text-xs">{t("noBarcodes")}</p>
              )}
              {camera ? (
                <CameraScanner
                  onCode={(code) => {
                    setCamera(false);
                    scanned(code);
                  }}
                  onClose={() => setCamera(false)}
                />
              ) : null}
              {message ? (
                <p
                  role={message.tone === "error" ? "alert" : "status"}
                  className={`text-sm ${message.tone === "error" ? "text-danger" : "text-success"}`}
                >
                  {message.text}
                </p>
              ) : null}
            </div>
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
            {items.length === 0 ? <p className="text-muted text-sm">{t("nothingOnSale")}</p> : null}
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
              {(category ? items.filter((i) => i.category.id === category) : items).map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className="border-border bg-surface hover:border-primary flex min-h-28 w-full flex-col items-start justify-between rounded-xl border p-3 text-start shadow-sm"
                    onClick={() => pick(i, false)}
                  >
                    {i.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- photos come from /media, cached by the browser
                      <img
                        src={i.imageUrl}
                        alt=""
                        className="mb-2 aspect-[4/3] w-full rounded-lg object-cover"
                      />
                    ) : null}
                    <span className="font-semibold">
                      <bdi>{named(i, locale)}</bdi>
                    </span>
                    <span className="ltr-value text-primary font-bold tabular-nums">
                      {fmt(i.price)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section
            aria-label={t("order")}
            className="border-border bg-surface space-y-3 self-start rounded-xl border p-4 shadow-sm"
          >
            {receipt ? (
              <div className="space-y-2" data-testid="sim-receipt">
                <p className="text-warning text-center text-xs font-bold uppercase">
                  {t("receiptMark")}
                </p>
                <p className="text-center font-semibold">
                  {data.branch.name} · {t("saleNo", { no: receipt.number })}
                </p>
                <ul className="divide-border divide-y text-sm">
                  {receipt.lines.map((l, i) => (
                    <li key={i} className="flex justify-between gap-2 py-1">
                      <span>
                        {l.quantity} × <bdi>{l.name}</bdi>
                      </span>
                      <span className="ltr-value tabular-nums">{fmt(l.gross)}</span>
                    </li>
                  ))}
                </ul>
                {receipt.discount !== "0.00" ? (
                  <p className="flex justify-between text-sm">
                    <span>{t("savings")}</span>
                    <span className="ltr-value">−{fmt(receipt.discount)}</span>
                  </p>
                ) : null}
                <p className="flex justify-between text-sm">
                  <span>{t("vat")}</span>
                  <span className="ltr-value">{fmt(receipt.tax)}</span>
                </p>
                <p className="flex justify-between font-bold">
                  <span>{t("total")}</span>
                  <span className="ltr-value" data-testid="sim-receipt-total">
                    {fmt(receipt.total)}
                  </span>
                </p>
                <p className="text-sm">
                  {t(`payments.${receipt.payment}`)}
                  {receipt.change !== "0.00" ? (
                    <span className="ltr-value">
                      {" "}
                      · {t("change")}: {fmt(receipt.change)}
                    </span>
                  ) : null}
                </p>
                <button
                  type="button"
                  className={`${buttonClass("primary")} w-full`}
                  onClick={() => setReceipt(null)}
                >
                  {t("newSale")}
                </button>
              </div>
            ) : (
              <>
                <h2 className="font-semibold">{t("order")}</h2>
                {cart.length === 0 ? <p className="text-muted text-sm">{t("empty")}</p> : null}
                <ul className="divide-border divide-y">
                  {cart.map((l, i) => (
                    <li
                      key={l.key}
                      className="flex items-center justify-between gap-2 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <bdi className="font-medium">{named(l.item, locale)}</bdi>
                        {l.scannedQty > 0 ? (
                          <span className="text-muted ms-1 text-xs">({t("scannedMark")})</span>
                        ) : null}
                        {l.optionNames.length ? (
                          <span className="text-muted block text-xs">
                            {l.optionNames.join(", ")}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={t("less", { name: named(l.item, locale) })}
                          className={`${buttonClass("secondary")} size-8 p-0`}
                          onClick={() =>
                            setCart((c) =>
                              c
                                .map((x) =>
                                  x.key === l.key
                                    ? {
                                        ...x,
                                        quantity: x.quantity - 1,
                                        scannedQty: Math.min(x.scannedQty, x.quantity - 1),
                                      }
                                    : x,
                                )
                                .filter((x) => x.quantity > 0),
                            )
                          }
                        >
                          −
                        </button>
                        <span className="w-6 text-center tabular-nums">{l.quantity}</span>
                        <button
                          type="button"
                          aria-label={t("more", { name: named(l.item, locale) })}
                          className={`${buttonClass("secondary")} size-8 p-0`}
                          onClick={() =>
                            setCart((c) =>
                              c.map((x) =>
                                x.key === l.key ? { ...x, quantity: x.quantity + 1 } : x,
                              ),
                            )
                          }
                        >
                          +
                        </button>
                        <span className="ltr-value w-20 text-end tabular-nums">
                          {fmt(priced.lines[i]?.gross ?? new Decimal(0))}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">{t("testAt")}</span>
                  <input
                    type="datetime-local"
                    value={testAt}
                    onChange={(e) => setTestAt(e.target.value)}
                    className={inputClass}
                  />
                  <span className="text-muted mt-1 block text-xs">{t("testAtHint")}</span>
                </label>
                {data.canDiscount ? (
                  <div className="flex items-end gap-2">
                    <label className="text-sm">
                      <span className="mb-1 block font-medium">{t("discount")}</span>
                      <input
                        value={discountValue}
                        onChange={(e) => setDiscountValue(e.target.value)}
                        inputMode="decimal"
                        dir="ltr"
                        className={`${inputClass} w-24`}
                      />
                    </label>
                    <select
                      aria-label={t("discountKind")}
                      value={discountKind}
                      onChange={(e) => setDiscountKind(e.target.value as "PERCENT" | "AMOUNT")}
                      className={`${inputClass} w-28`}
                    >
                      <option value="PERCENT">%</option>
                      <option value="AMOUNT">{data.currency}</option>
                    </select>
                  </div>
                ) : null}
                {savings.gt(0) ? (
                  <p className="text-success flex justify-between text-sm">
                    <span>{t("savings")}</span>
                    <span className="ltr-value">−{fmt(savings)}</span>
                  </p>
                ) : null}
                <p className="text-muted flex justify-between text-sm">
                  <span>{t("vat")}</span>
                  <span className="ltr-value tabular-nums">{fmt(priced.tax)}</span>
                </p>
                <p className="flex justify-between text-lg font-bold">
                  <span>{t("total")}</span>
                  <span className="ltr-value tabular-nums" data-testid="sim-total">
                    {fmt(priced.total)}
                  </span>
                </p>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("payment")}>
                  {(["CASH", "CARD", "SPLIT"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={payment === p}
                      className={chip(payment === p)}
                      onClick={() => setPayment(p)}
                    >
                      {t(`payments.${p}`)}
                    </button>
                  ))}
                </div>
                {payment === "SPLIT" ? (
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">{t("cardPart")}</span>
                    <input
                      value={cardPart}
                      onChange={(e) => setCardPart(e.target.value)}
                      inputMode="decimal"
                      dir="ltr"
                      className={inputClass}
                    />
                  </label>
                ) : null}
                {payment !== "CARD" ? (
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">{t("tendered")}</span>
                    <input
                      value={tendered}
                      onChange={(e) => setTendered(e.target.value)}
                      inputMode="decimal"
                      dir="ltr"
                      className={inputClass}
                    />
                  </label>
                ) : null}
                <button
                  type="button"
                  className={`${buttonClass("primary")} min-h-12 w-full`}
                  disabled={cart.length === 0}
                  onClick={complete}
                >
                  {t("complete")}
                </button>
              </>
            )}
          </section>
        </div>
      ) : null}

      {tab === "BOARD" ? (
        <div className="space-y-3">
          {data.boards.length === 0 ? (
            <p className="text-muted text-sm">{t("noBoards")}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">{t("board")}</span>
                  <select
                    value={boardId}
                    onChange={(e) => setBoardId(e.target.value)}
                    className={inputClass}
                  >
                    {data.boards.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">{t("boardAt")}</span>
                  <input
                    type="time"
                    value={boardAt}
                    onChange={(e) => setBoardAt(e.target.value)}
                    className={inputClass}
                    dir="ltr"
                  />
                </label>
                {board ? (
                  <a
                    href={`${board.path}?at=${encodeURIComponent(boardAt)}`}
                    target="_blank"
                    rel="noopener"
                    className={buttonClass("secondary")}
                  >
                    {t("openFullScreen")}
                  </a>
                ) : null}
              </div>
              {board ? (
                <div
                  className={`${board.theme === "DARK" ? "board-dark" : "board-light"} bg-background text-foreground border-border overflow-hidden rounded-xl border p-4`}
                  data-testid="sim-board"
                  data-theme={board.theme}
                >
                  {boardItems.length === 0 ? (
                    <p className="text-muted">{t("boardEmpty")}</p>
                  ) : (
                    <MenuBoard
                      items={boardItems}
                      currency={data.currency}
                      pageSeconds={board.pageSeconds}
                    />
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {tab === "SESSION" ? (
        <div className="space-y-4" data-testid="sim-session">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(
              [
                ["sales", String(summary.sales)],
                ["total", fmt(summary.total)],
                ["vat", fmt(summary.tax)],
                ["average", fmt(summary.average)],
                ["cash", fmt(summary.cash)],
                ["card", fmt(summary.card)],
                ["savings", fmt(summary.discount)],
                ["voided", String(summary.voided)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="border-border bg-surface rounded-xl border p-3">
                <span className="text-muted block text-xs">{t(`summary.${k}`)}</span>
                <span className="ltr-value text-xl font-semibold tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          <div className="grid gap-4 text-sm md:grid-cols-3">
            {(["byChannel", "byPayment", "byEntry"] as const).map((g) => (
              <div key={g} className="border-border bg-surface rounded-xl border p-3">
                <p className="mb-2 font-semibold">{t(`summary.${g}`)}</p>
                <ul className="space-y-1">
                  {summary[g].map((r) => (
                    <li key={r.key} className="flex justify-between">
                      <span>
                        {g === "byChannel"
                          ? tm(`channels.${r.key as "DINE_IN"}`)
                          : g === "byPayment"
                            ? t(`payments.${r.key as "CASH"}`)
                            : t(`entries.${r.key as "PUNCH"}`)}{" "}
                        ({r.count})
                      </span>
                      <span className="ltr-value tabular-nums">{fmt(r.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {sales.length > 0 ? (
            <ul className="divide-border border-border bg-surface divide-y rounded-xl border text-sm">
              {[...sales].reverse().map((s) => (
                <li
                  key={s.number}
                  className="flex flex-wrap items-center justify-between gap-2 p-3"
                >
                  <span className={s.voided ? "text-muted line-through" : ""}>
                    {t("saleNo", { no: s.number })} · {tm(`channels.${s.channel as "DINE_IN"}`)} ·{" "}
                    {t(`entries.${s.entry}`)} · {t(`payments.${s.payment}`)} ·{" "}
                    <span className="ltr-value">{fmt(s.total)}</span>
                  </span>
                  {s.voided ? null : (
                    <button
                      type="button"
                      className={buttonClass("secondary")}
                      onClick={() =>
                        setSales((all) =>
                          all.map((x) => (x.number === s.number ? { ...x, voided: true } : x)),
                        )
                      }
                    >
                      {t("void")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">{t("noSales")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass("secondary")}
              disabled={sales.length === 0}
              onClick={download}
            >
              {t("exportCsv")}
            </button>
            <button
              type="button"
              className={buttonClass("danger")}
              disabled={sales.length === 0}
              onClick={() => {
                if (window.confirm(t("clearConfirm"))) setSales([]);
              }}
            >
              {t("clear")}
            </button>
          </div>
        </div>
      ) : null}

      {choosing ? (
        <OptionsDialog
          item={choosing.item}
          fmt={(d) => fmt(d)}
          onCancel={() => setChoosing(null)}
          onAdd={(optionIds) => {
            add(choosing.item, optionIds, choosing.scanned);
            setChoosing(null);
          }}
        />
      ) : null}
    </div>
  );
}
