"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { Decimal } from "@/lib/decimal";
import { lineAmounts, splitEvenly } from "@/modules/pos/rules";
import {
  DiscountPanel,
  discountPayload,
  priceWithDiscounts,
  type DiscountChoice,
} from "./discount-panel";
import { named, OptionsDialog, type MenuItemView } from "./till";

/** A check as plain values (server Decimals arrive as strings). */
export interface CheckView {
  id: string;
  number: string;
  status: "OPEN" | "CLOSED" | "CANCELLED" | "MERGED";
  tableCode: string | null;
  label: string | null;
  guests: number;
  currency: string;
  lines: Array<{
    id: string;
    lineNo: number;
    name: string;
    optionNames: string[];
    quantity: string;
    paidQuantity: string;
    remaining: string;
    seat: number | null;
    course: number;
    note: string | null;
    hold: boolean;
    status: "PENDING" | "SENT" | "VOIDED";
    unitPrice: string | null;
    includesTax: boolean | null;
    taxRate: string | null;
    gross: string | null;
    /** Promotion on the item as ordered (ADR-067). */
    promotion: { name: string; percent: string } | null;
    voidReason: string | null;
    /** From the kitchen screens (POS2b): preparing until bumped, then ready. */
    kitchen: "PREPARING" | "READY" | null;
  }>;
  orders: Array<{ id: string; number: string; gross: string }>;
  otherTabs: Array<{ id: string; label: string }>;
  freeTables: Array<{ id: string; code: string }>;
  registers: Array<{ id: string; label: string }>;
  can: { serve: boolean; pay: boolean; void: boolean; open: boolean; discount: boolean };
  /** Pay by QR (Moyasar) is set up for the organization (ADR-066). */
  onlinePayments: boolean;
}

type Result = { ok: true; data?: Record<string, unknown> } | { ok: false; error: string };

interface Staged {
  key: string;
  item: MenuItemView;
  optionIds: string[];
  optionNames: string[];
  quantity: number;
  seat: string;
  course: number;
  hold: boolean;
  note: string;
}

/**
 * The waiter's and cashier's check screen (ADR-062): add items with seat,
 * course and notes, send them (or hold a course and fire it later), void
 * what the kitchen has, move or merge, and pay all, by items or seats, or
 * evenly in several payments.
 */
export function CheckScreen({
  orgSlug,
  check,
  menu,
  actions,
}: {
  orgSlug: string;
  check: CheckView;
  menu: MenuItemView[];
  actions: {
    addLines: (input: unknown) => Promise<Result>;
    updateLine: (lineId: string, input: unknown) => Promise<Result>;
    removeLine: (lineId: string) => Promise<Result>;
    send: (input: unknown) => Promise<Result>;
    voidLine: (lineId: string, input: unknown) => Promise<Result>;
    move: (input: unknown) => Promise<Result>;
    merge: (input: unknown) => Promise<Result>;
    cancel: (input: unknown) => Promise<Result>;
    pay: (input: unknown) => Promise<Result>;
    createLink: (input: unknown) => Promise<Result>;
    refreshLink: (linkId: string) => Promise<Result>;
    cancelLink: (linkId: string) => Promise<Result>;
    coupon: (registerId: string, code: string) => Promise<Result>;
  };
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const money = useMemo(
    () =>
      new Intl.NumberFormat(`${locale}-u-nu-latn`, { style: "currency", currency: check.currency }),
    [locale, check.currency],
  );
  const fmt = (d: Decimal | string) => money.format(d.toString() as unknown as number);
  const editable = check.can.open && check.can.serve;

  const act = (fn: () => Promise<Result>, after?: (r: Extract<Result, { ok: true }>) => void) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        after?.(r);
        router.refresh();
      }
    });

  // ─── Adding items ───
  const [staged, setStaged] = useState<Staged[]>([]);
  const [choosing, setChoosing] = useState<MenuItemView | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [course, setCourse] = useState(1);
  const [seat, setSeat] = useState("");
  const categories = [...new Map(menu.map((i) => [i.category.id, i.category])).values()];
  const stage = (item: MenuItemView, optionIds: string[] = []) => {
    const options = item.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id));
    setStaged((s) => [
      ...s,
      {
        key: crypto.randomUUID(),
        item,
        optionIds,
        optionNames: options.map((o) => named(o, locale)),
        quantity: 1,
        seat,
        course,
        hold: course > 1,
        note: "",
      },
    ]);
  };
  const addStaged = () =>
    act(
      () =>
        actions.addLines({
          lines: staged.map((s) => ({
            itemId: s.item.id,
            quantity: String(s.quantity),
            optionIds: s.optionIds,
            course: s.course,
            hold: s.hold,
            ...(s.seat ? { seat: Number(s.seat) } : {}),
            ...(s.note.trim() ? { note: s.note.trim() } : {}),
          })),
        }),
      () => setStaged([]),
    );

  // ─── Sending ───
  const unsent = check.lines.filter((l) => l.status === "PENDING" && !l.hold).length;
  const heldCourses = [
    ...new Set(check.lines.filter((l) => l.status === "PENDING" && l.hold).map((l) => l.course)),
  ].sort();

  // ─── Paying ───
  const [mode, setMode] = useState<"all" | "items" | "seat">("all");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [paySeat, setPaySeat] = useState("");
  const [parts, setParts] = useState(1);
  const [method, setMethod] = useState<"CASH" | "CARD" | "QR">("CARD");
  const [link, setLink] = useState<{ id: string; url: string; qr: string } | null>(null);
  const [tendered, setTendered] = useState("");
  const [discount, setDiscount] = useState<DiscountChoice>(null);
  const [registerId, setRegisterId] = useState(check.registers[0]?.id ?? "");
  const orderId = useRef<string | null>(null);
  const payable = check.lines.filter((l) => new Decimal(l.remaining).gt(0));
  const seats = [
    ...new Set(payable.map((l) => l.seat).filter((s): s is number => s !== null)),
  ].sort((a, b) => a - b);
  const selection: Array<{ line: CheckView["lines"][number]; quantity: Decimal }> =
    mode === "all"
      ? payable.map((l) => ({ line: l, quantity: new Decimal(l.remaining) }))
      : mode === "seat"
        ? payable
            .filter((l) => String(l.seat ?? "") === paySeat)
            .map((l) => ({ line: l, quantity: new Decimal(l.remaining) }))
        : payable
            .filter((l) => /^\d+(\.\d+)?$/.test(chosen[l.id] ?? "") && Number(chosen[l.id]) > 0)
            .map((l) => ({ line: l, quantity: new Decimal(chosen[l.id]) }));
  const priced = selection.every((s) => s.line.unitPrice !== null);
  // Pay by QR takes promotions but no order discount (ADR-067).
  const orderDiscount = method === "QR" ? null : discount;
  const discounted = priceWithDiscounts(
    selection.map((s) => {
      const rate = s.line.taxRate === null ? null : new Decimal(s.line.taxRate);
      return {
        gross: lineAmounts(
          new Decimal(s.line.unitPrice ?? 0),
          s.quantity,
          s.line.includesTax ?? true,
          rate,
          check.currency,
        ).gross,
        rate,
        promoPercent: s.line.promotion ? new Decimal(s.line.promotion.percent) : null,
      };
    }),
    orderDiscount,
    check.currency,
  );
  const total = discounted.total;
  const split = total.gt(0) ? splitEvenly(total, parts, check.currency) : [];
  const pay = () => {
    if (!registerId) return;
    const cashTendered =
      method === "CASH" && parts === 1 && /^\d+(\.\d+)?$/.test(tendered)
        ? new Decimal(tendered)
        : null;
    if (cashTendered && cashTendered.lt(total)) {
      setError(t("pos.tenderedTooLow"));
      return;
    }
    orderId.current ??= crypto.randomUUID();
    act(
      () =>
        actions.pay({
          orderId: orderId.current,
          registerId,
          lines:
            mode === "all"
              ? []
              : selection.map((s) => ({ tabLineId: s.line.id, quantity: s.quantity.toFixed() })),
          payments: split.map((amount) => ({
            method,
            amount: amount.toFixed(),
            ...(cashTendered ? { tendered: cashTendered.toFixed() } : {}),
          })),
          ...discountPayload(orderDiscount),
          expectedTotal: total.toFixed(),
        }),
      (r) => {
        orderId.current = null;
        setChosen({});
        setTendered("");
        setParts(1);
        setDiscount(null);
        const change = new Decimal(String(r.data?.change ?? "0"));
        setNotice(
          [
            t("pos.paid", { number: String(r.data?.number ?? "") }),
            change.gt(0) ? `${t("pos.change")} ${fmt(change)}` : "",
            r.data?.closed ? t("pos.checkClosed") : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
      },
    );
  };

  const statusOf = (l: CheckView["lines"][number]) =>
    l.status === "VOIDED"
      ? t("pos.lineStatuses.VOIDED")
      : new Decimal(l.paidQuantity).gte(l.quantity)
        ? t("pos.lineStatuses.PAID")
        : l.status === "PENDING"
          ? l.hold
            ? t("pos.lineStatuses.HELD")
            : t("pos.lineStatuses.PENDING")
          : l.kitchen === "READY"
            ? t("pos.lineStatuses.READY")
            : l.kitchen === "PREPARING"
              ? t("pos.lineStatuses.PREPARING")
              : t("pos.lineStatuses.SENT");
  const courses = [...new Set(check.lines.map((l) => l.course))].sort();
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const chip = (active: boolean) =>
    `min-h-11 rounded-full border px-4 text-sm font-medium ${
      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface"
    }`;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_26rem]">
      <div className="space-y-4 lg:col-span-2">
        {error ? (
          <p
            role="alert"
            className="border-danger/40 bg-danger-surface text-danger rounded-md border px-3 py-2 text-sm"
          >
            {error}
          </p>
        ) : null}
        {notice ? (
          <p
            role="status"
            className="border-success/40 bg-success-surface text-success rounded-md border px-3 py-2 text-sm"
          >
            {notice}
          </p>
        ) : null}
      </div>

      {/* The check */}
      <section
        aria-label={t("pos.checkItems")}
        className="border-border bg-surface space-y-3 rounded-lg border p-4"
      >
        {check.lines.length === 0 ? (
          <p className="text-muted text-sm">{t("pos.noCheckItems")}</p>
        ) : null}
        {courses.map((c) => (
          <div key={c}>
            <h3 className="text-muted mb-1 text-xs font-semibold uppercase">
              {t("pos.courseN", { n: c })}
            </h3>
            <ul className="divide-border divide-y">
              {check.lines
                .filter((l) => l.course === c)
                .map((l) => (
                  <li key={l.id} className="py-2" data-testid={`check-line-${l.lineNo}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p
                          className={
                            l.status === "VOIDED" ? "text-muted line-through" : "font-medium"
                          }
                        >
                          <span className="ltr-value tabular-nums">
                            {new Decimal(l.quantity).toFixed()}
                          </span>{" "}
                          × <bdi>{l.name}</bdi>
                        </p>
                        {l.optionNames.length > 0 ? (
                          <p className="text-muted text-xs">{l.optionNames.join(" · ")}</p>
                        ) : null}
                        {l.note ? <p className="text-xs italic">“{l.note}”</p> : null}
                        {l.voidReason ? (
                          <p className="text-danger text-xs">{l.voidReason}</p>
                        ) : null}
                        <p className="text-muted text-xs">
                          {l.seat ? `${t("pos.seatN", { n: l.seat })} · ` : ""}
                          <span data-testid="line-status">{statusOf(l)}</span>
                          {new Decimal(l.paidQuantity).gt(0) &&
                          new Decimal(l.paidQuantity).lt(l.quantity)
                            ? ` · ${t("pos.paidQty", { quantity: new Decimal(l.paidQuantity).toFixed() })}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="ltr-value text-sm tabular-nums">
                          {l.gross ? fmt(l.gross) : t("pos.notOnSale")}
                        </span>
                        {l.promotion && l.status !== "VOIDED" ? (
                          <span className="bg-success-surface rounded px-1 text-xs">
                            {t("pos.promotionTag", {
                              name: l.promotion.name,
                              percent: l.promotion.percent,
                            })}
                          </span>
                        ) : null}
                        {editable &&
                        l.status === "PENDING" &&
                        new Decimal(l.paidQuantity).isZero() ? (
                          <button
                            type="button"
                            className="text-danger text-xs hover:underline"
                            disabled={pending}
                            onClick={() => act(() => actions.removeLine(l.id))}
                          >
                            {t("pos.takeBack")}
                          </button>
                        ) : null}
                        {check.can.open &&
                        check.can.void &&
                        l.status === "SENT" &&
                        new Decimal(l.paidQuantity).isZero() ? (
                          <button
                            type="button"
                            className="text-danger text-xs hover:underline"
                            onClick={() => {
                              setVoiding(l.id);
                              setVoidReason("");
                            }}
                          >
                            {t("pos.voidItem")}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {voiding === l.id ? (
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="flex-1 text-sm">
                          <span className="mb-1 block">{t("pos.voidReason")}</span>
                          <input
                            className={inputClass}
                            value={voidReason}
                            onChange={(e) => setVoidReason(e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          className={buttonClass("danger")}
                          disabled={pending || !voidReason.trim()}
                          onClick={() =>
                            act(
                              () => actions.voidLine(l.id, { reason: voidReason.trim() }),
                              () => setVoiding(null),
                            )
                          }
                        >
                          {t("pos.voidItem")}
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
            </ul>
          </div>
        ))}
        {editable && (unsent > 0 || heldCourses.length > 0) ? (
          <div className="border-border flex flex-wrap gap-2 border-t pt-3">
            {unsent > 0 ? (
              <button
                type="button"
                className={`${buttonClass("primary")} min-h-12`}
                disabled={pending}
                onClick={() =>
                  act(
                    () => actions.send({}),
                    (r) => setNotice(t("pos.sentCount", { count: Number(r.data?.sent ?? 0) })),
                  )
                }
              >
                {t("pos.sendToKitchen", { count: unsent })}
              </button>
            ) : null}
            {heldCourses.map((c) => (
              <button
                key={c}
                type="button"
                className={`${buttonClass("secondary")} min-h-12`}
                disabled={pending}
                onClick={() =>
                  act(
                    () => actions.send({ course: c }),
                    (r) => setNotice(t("pos.sentCount", { count: Number(r.data?.sent ?? 0) })),
                  )
                }
              >
                {t("pos.fireCourse", { n: c })}
              </button>
            ))}
          </div>
        ) : null}
        {check.orders.length > 0 ? (
          <div className="border-border border-t pt-3 text-sm">
            <p className="font-medium">{t("pos.payments")}</p>
            <ul>
              {check.orders.map((o) => (
                <li key={o.id} className="flex justify-between">
                  <Link
                    href={`/o/${orgSlug}/pos/orders/${o.id}/receipt`}
                    className="text-primary ltr-value hover:underline"
                  >
                    {o.number}
                  </Link>
                  <span className="ltr-value tabular-nums">{fmt(o.gross)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* Paying */}
      {check.can.open && check.can.pay && payable.length > 0 ? (
        <section
          aria-label={t("pos.payCheck")}
          className="border-border bg-surface space-y-3 self-start rounded-lg border p-4"
        >
          <h2 className="text-lg font-semibold">{t("pos.payCheck")}</h2>
          {check.registers.length === 0 ? (
            <p className="text-muted text-sm">{t("pos.refundNeedsShift")}</p>
          ) : (
            <>
              <div role="radiogroup" aria-label={t("pos.payWhat")} className="flex flex-wrap gap-2">
                {(["all", "items", ...(seats.length > 0 ? ["seat"] : [])] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    className={chip(mode === m)}
                    onClick={() => setMode(m as typeof mode)}
                  >
                    {t(`pos.payModes.${m}`)}
                  </button>
                ))}
              </div>
              {mode === "items" ? (
                <ul className="space-y-1 text-sm">
                  {payable.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2">
                      <label htmlFor={`pay-${l.id}`}>
                        <bdi>{l.name}</bdi>{" "}
                        <span className="text-muted">
                          {t("pos.refundLeft", { quantity: new Decimal(l.remaining).toFixed() })}
                        </span>
                      </label>
                      <input
                        id={`pay-${l.id}`}
                        className={`${inputClass} w-20`}
                        inputMode="decimal"
                        dir="ltr"
                        value={chosen[l.id] ?? ""}
                        onChange={(e) =>
                          setChosen((c) => ({ ...c, [l.id]: e.target.value.trim() }))
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              {mode === "seat" ? (
                <label className="block text-sm">
                  <span className="mb-1 block">{t("pos.seat")}</span>
                  <select
                    className={inputClass}
                    value={paySeat}
                    onChange={(e) => setPaySeat(e.target.value)}
                  >
                    <option value="">—</option>
                    {seats.map((s) => (
                      <option key={s} value={String(s)}>
                        {t("pos.seatN", { n: s })}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <label>
                  <span className="mb-1 block">{t("pos.splitInto")}</span>
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={20}
                    value={parts}
                    onChange={(e) =>
                      setParts(Math.min(20, Math.max(1, Number(e.target.value) || 1)))
                    }
                  />
                </label>
                <label>
                  <span className="mb-1 block">{t("pos.paymentMethod")}</span>
                  <select
                    className={inputClass}
                    value={method}
                    onChange={(e) => setMethod(e.target.value as "CASH" | "CARD" | "QR")}
                  >
                    <option value="CARD">{t("pos.methods.CARD")}</option>
                    <option value="CASH">{t("pos.methods.CASH")}</option>
                    {check.onlinePayments ? (
                      <option value="QR">{t("pos.methods.QR")}</option>
                    ) : null}
                  </select>
                </label>
                {check.registers.length > 1 ? (
                  <label className="col-span-2">
                    <span className="mb-1 block">{t("pos.payAtRegister")}</span>
                    <select
                      className={inputClass}
                      value={registerId}
                      onChange={(e) => setRegisterId(e.target.value)}
                    >
                      {check.registers.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {method === "CASH" && parts === 1 ? (
                  <label className="col-span-2">
                    <span className="mb-1 block">{t("pos.tendered")}</span>
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      dir="ltr"
                      value={tendered}
                      onChange={(e) => setTendered(e.target.value.trim())}
                    />
                  </label>
                ) : null}
              </div>
              {method !== "QR" && selection.length > 0 ? (
                <DiscountPanel
                  idPrefix="check"
                  canDiscount={check.can.discount}
                  choice={discount}
                  onChange={(c) => {
                    setDiscount(c);
                    orderId.current = null;
                  }}
                  lookup={(code) => actions.coupon(registerId, code)}
                />
              ) : null}
              {discounted.promoDiscount.gt(0) ? (
                <div className="flex justify-between text-sm">
                  <span className="text-muted">{t("pos.promotions")}</span>
                  <span className="ltr-value tabular-nums">−{fmt(discounted.promoDiscount)}</span>
                </div>
              ) : null}
              {discounted.orderDiscount.gt(0) ? (
                <div className="flex justify-between text-sm">
                  <span className="text-muted">{t("pos.discount")}</span>
                  <span className="ltr-value tabular-nums">−{fmt(discounted.orderDiscount)}</span>
                </div>
              ) : null}
              <div className="flex justify-between text-xl font-semibold">
                <span>{t("pos.total")}</span>
                <span className="ltr-value tabular-nums" data-testid="check-total">
                  {fmt(total)}
                </span>
              </div>
              {parts > 1 && split.length > 0 ? (
                <p className="text-muted text-sm">
                  {t("pos.eachPays")}{" "}
                  <span className="ltr-value">{split.map((p) => fmt(p)).join(" + ")}</span>
                </p>
              ) : null}
              {!priced ? <p className="text-danger text-sm">{t("pos.itemNotPriced")}</p> : null}
              {method === "QR" ? (
                <QrPayment
                  link={link}
                  disabled={pending || !priced || !total.gt(0) || !registerId || parts > 1}
                  onCreate={() =>
                    act(
                      () =>
                        actions.createLink({
                          registerId,
                          lines:
                            mode === "all"
                              ? []
                              : selection.map((s) => ({
                                  tabLineId: s.line.id,
                                  quantity: s.quantity.toFixed(),
                                })),
                          expectedTotal: total.toFixed(),
                        }),
                      async (r) => {
                        const url = String(r.data?.url ?? "");
                        const QRCode = (await import("qrcode")).default;
                        setLink({
                          id: String(r.data?.id),
                          url,
                          qr: await QRCode.toDataURL(url, { margin: 1 }),
                        });
                      },
                    )
                  }
                  onCheck={async () => {
                    if (!link) return;
                    const r = await actions.refreshLink(link.id);
                    if (!r.ok) setError(r.error);
                    else if (r.data?.status === "RECORDED") {
                      setLink(null);
                      setNotice(t("pos.qrPaid"));
                      router.refresh();
                    } else if (r.data?.status === "FAILED" || r.data?.status === "CANCELLED") {
                      setLink(null);
                      setError(t("pos.qrNotPaid"));
                    }
                  }}
                  onCancel={() =>
                    link &&
                    act(
                      () => actions.cancelLink(link.id),
                      () => setLink(null),
                    )
                  }
                />
              ) : (
                <button
                  type="button"
                  className={`${buttonClass("primary")} min-h-12 w-full`}
                  disabled={pending || !priced || selection.length === 0 || !registerId}
                  onClick={pay}
                >
                  {pending ? t("common.saving") : t("pos.takePayment")}
                </button>
              )}
            </>
          )}
        </section>
      ) : null}

      {/* Adding items */}
      {editable ? (
        <section aria-label={t("pos.addItems")} className="space-y-3 lg:col-span-2">
          <h2 className="text-lg font-semibold">{t("pos.addItems")}</h2>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label>
              <span className="mb-1 block">{t("pos.course")}</span>
              <select
                className={inputClass}
                value={course}
                onChange={(e) => setCourse(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {t("pos.courseN", { n })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block">{t("pos.seat")}</span>
              <select className={inputClass} value={seat} onChange={(e) => setSeat(e.target.value)}>
                <option value="">{t("pos.shared")}</option>
                {Array.from({ length: Math.max(check.guests, 1) }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={String(n)}>
                    {t("pos.seatN", { n })}
                  </option>
                ))}
              </select>
            </label>
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
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {menu
              .filter((i) => category === null || i.category.id === category)
              .map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className="border-border bg-surface hover:border-primary flex min-h-16 w-full flex-col items-start justify-between rounded-lg border p-3 text-start"
                    onClick={() => (i.groups.length > 0 ? setChoosing(i) : stage(i))}
                  >
                    <span className="font-medium">
                      <bdi>{named(i, locale)}</bdi>
                    </span>
                    <span className="ltr-value text-muted text-sm tabular-nums">
                      {fmt(i.price)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          {staged.length > 0 ? (
            <div
              className="border-border bg-surface space-y-2 rounded-lg border p-3"
              data-testid="staged"
            >
              {staged.map((s) => (
                <div key={s.key} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-32 font-medium">
                    <bdi>{named(s.item, locale)}</bdi>
                    {s.optionNames.length > 0 ? (
                      <span className="text-muted"> · {s.optionNames.join(", ")}</span>
                    ) : null}
                  </span>
                  <span className="text-muted">
                    {t("pos.courseN", { n: s.course })}
                    {s.seat ? ` · ${t("pos.seatN", { n: s.seat })}` : ""}
                  </span>
                  <input
                    aria-label={t("pos.note")}
                    placeholder={t("pos.note")}
                    className={`${inputClass} w-40`}
                    value={s.note}
                    onChange={(e) =>
                      setStaged((all) =>
                        all.map((x) => (x.key === s.key ? { ...x, note: e.target.value } : x)),
                      )
                    }
                  />
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={s.hold}
                      onChange={(e) =>
                        setStaged((all) =>
                          all.map((x) => (x.key === s.key ? { ...x, hold: e.target.checked } : x)),
                        )
                      }
                    />
                    {t("pos.holdItem")}
                  </label>
                  <button
                    type="button"
                    className="text-danger text-xs hover:underline"
                    onClick={() => setStaged((all) => all.filter((x) => x.key !== s.key))}
                  >
                    {t("pos.takeBack")}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={`${buttonClass("primary")} min-h-12`}
                disabled={pending}
                onClick={addStaged}
              >
                {t("pos.addToCheck", { count: staged.length })}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Table actions */}
      {editable ? (
        <section
          aria-label={t("pos.checkActions")}
          className="border-border space-y-3 rounded-lg border p-4 lg:col-span-2"
        >
          <TableActions check={check} pending={pending} act={act} actions={actions} />
        </section>
      ) : null}

      {choosing ? (
        <OptionsDialog
          item={choosing}
          fmt={(d) => fmt(d)}
          onCancel={() => setChoosing(null)}
          onAdd={(ids) => {
            stage(choosing, ids);
            setChoosing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TableActions({
  check,
  pending,
  act,
  actions,
}: {
  check: CheckView;
  pending: boolean;
  act: (fn: () => Promise<Result>, after?: (r: Extract<Result, { ok: true }>) => void) => void;
  actions: {
    move: (input: unknown) => Promise<Result>;
    merge: (input: unknown) => Promise<Result>;
    cancel: (input: unknown) => Promise<Result>;
  };
}) {
  const t = useTranslations();
  const [moveTo, setMoveTo] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="grid gap-4 text-sm sm:grid-cols-3">
      {check.freeTables.length > 0 ? (
        <div className="space-y-1">
          <label htmlFor="move-to" className="block font-medium">
            {t("pos.moveToTable")}
          </label>
          <div className="flex gap-2">
            <select
              id="move-to"
              className={inputClass}
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
            >
              <option value="">—</option>
              {check.freeTables.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={buttonClass("secondary")}
              disabled={pending || !moveTo}
              onClick={() => act(() => actions.move({ tableId: moveTo }))}
            >
              {t("pos.move")}
            </button>
          </div>
        </div>
      ) : null}
      {check.otherTabs.length > 0 && check.orders.length === 0 ? (
        <div className="space-y-1">
          <label htmlFor="merge-into" className="block font-medium">
            {t("pos.mergeInto")}
          </label>
          <div className="flex gap-2">
            <select
              id="merge-into"
              className={inputClass}
              value={mergeInto}
              onChange={(e) => setMergeInto(e.target.value)}
            >
              <option value="">—</option>
              {check.otherTabs.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={buttonClass("secondary")}
              disabled={pending || !mergeInto}
              onClick={() => {
                if (window.confirm(t("pos.mergeConfirm")))
                  act(() => actions.merge({ intoTabId: mergeInto }));
              }}
            >
              {t("pos.merge")}
            </button>
          </div>
        </div>
      ) : null}
      {check.orders.length === 0 ? (
        <div className="space-y-1">
          <label htmlFor="cancel-reason" className="block font-medium">
            {t("pos.cancelCheck")}
          </label>
          <div className="flex gap-2">
            <input
              id="cancel-reason"
              className={inputClass}
              placeholder={t("pos.reason")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className={buttonClass("danger")}
              disabled={pending || !reason.trim()}
              onClick={() => act(() => actions.cancel({ reason: reason.trim() }))}
            >
              {t("pos.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Pay by QR: the guest scans and pays on their phone (mada, Apple Pay,
 * cards) at Moyasar; the screen checks every few seconds and the payment is
 * recorded on the check once confirmed (ADR-066).
 */
function QrPayment({
  link,
  disabled,
  onCreate,
  onCheck,
  onCancel,
}: {
  link: { id: string; url: string; qr: string } | null;
  disabled: boolean;
  onCreate: () => void;
  onCheck: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const check = useRef(onCheck);
  useEffect(() => {
    check.current = onCheck;
  });
  useEffect(() => {
    if (!link) return;
    const timer = window.setInterval(() => void check.current(), 4000);
    return () => window.clearInterval(timer);
  }, [link]);
  if (!link)
    return (
      <button
        type="button"
        className={`${buttonClass("primary")} min-h-12 w-full`}
        disabled={disabled}
        onClick={onCreate}
      >
        {t("pos.showQr")}
      </button>
    );
  return (
    <div className="space-y-2 text-center" data-testid="qr-payment">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL drawn on the device */}
      <img src={link.qr} alt={t("pos.qrAlt")} className="mx-auto h-56 w-56" />
      <p className="text-muted text-sm">{t("pos.qrWaiting")}</p>
      <p className="text-xs break-all">
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          {link.url}
        </a>
      </p>
      <div className="flex justify-center gap-2">
        <button type="button" className={buttonClass("secondary")} onClick={() => void onCheck()}>
          {t("pos.qrCheckNow")}
        </button>
        <button type="button" className={buttonClass("danger")} onClick={onCancel}>
          {t("pos.qrCancel")}
        </button>
      </div>
    </div>
  );
}
