"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { Decimal } from "@/lib/decimal";
import { formatGiftCardCode, pointsValue } from "@/modules/pos/loyalty-rules";
import type { DiscountChoice } from "./discount-panel";

type Result = { ok: true; data?: Record<string, unknown> } | { ok: false; error: string };
export interface TillCustomer {
  id: string;
  name: string;
  points: number;
}

/**
 * The order's customer at the till (ADR-068): found by phone or added, and
 * their points spent as the order discount. Needs a connection.
 */
export function CustomerPanel({
  online,
  currency,
  customer,
  onCustomer,
  loyalty,
  choice,
  onChoice,
  find,
  add,
  fmt,
}: {
  online: boolean;
  currency: string;
  customer: TillCustomer | null;
  onCustomer: (c: TillCustomer | null) => void;
  loyalty: { pointValue: string; minRedeemPoints: number } | null;
  choice: DiscountChoice;
  onChoice: (c: DiscountChoice) => void;
  find: (phone: string) => Promise<Result>;
  add: (input: unknown) => Promise<Result>;
  fmt: (d: Decimal) => string;
}) {
  const t = useTranslations("pos");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [adding, setAdding] = useState(false);
  const [points, setPoints] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (customer) {
    const spendable =
      loyalty && customer.points >= loyalty.minRedeemPoints && choice === null ? loyalty : null;
    return (
      <div className="space-y-2 text-sm" data-testid="till-customer">
        <div className="flex items-center justify-between gap-2">
          <span>
            <bdi className="font-medium">{customer.name}</bdi>
            {loyalty ? ` · ${t("pointsBalance", { points: customer.points })}` : ""}
          </span>
          <button
            type="button"
            className="text-danger hover:underline"
            onClick={() => {
              if (choice?.type === "points") onChoice(null);
              onCustomer(null);
            }}
          >
            {t("removeCustomer")}
          </button>
        </div>
        {spendable ? (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="till-points" className="mb-1 block">
                {t("spendPoints")}
              </label>
              <input
                id="till-points"
                className={inputClass}
                inputMode="numeric"
                dir="ltr"
                value={points}
                onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => {
                const n = Number(points);
                if (!n || n < spendable.minRedeemPoints || n > customer.points)
                  return setError(
                    t("pointsRange", { min: spendable.minRedeemPoints, max: customer.points }),
                  );
                setError(null);
                const value = pointsValue(n, new Decimal(spendable.pointValue), currency);
                onChoice({ type: "points", points: n, kind: "AMOUNT", value: value.toFixed() });
              }}
            >
              {t("applyPoints")}
            </button>
          </div>
        ) : null}
        {spendable && /^\d+$/.test(points) ? (
          <p className="text-muted text-xs">
            {t("pointsWorth", {
              value: fmt(pointsValue(Number(points), new Decimal(spendable.pointValue), currency)),
            })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <details className="text-sm">
      <summary className="cursor-pointer">{t("customer")}</summary>
      {!online ? (
        <p className="text-muted mt-2">{t("needsConnection")}</p>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="till-phone" className="mb-1 block">
                {t("customerPhone")}
              </label>
              <input
                id="till-phone"
                className={inputClass}
                inputMode="tel"
                dir="ltr"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={buttonClass("secondary")}
              disabled={pending || phone.trim().length < 9}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await find(phone);
                  if (r.ok) onCustomer(r.data as unknown as TillCustomer);
                  else {
                    setAdding(true);
                    setError(r.error);
                  }
                })
              }
            >
              {t("findCustomer")}
            </button>
          </div>
          {adding ? (
            <div className="border-border space-y-2 rounded-md border p-2">
              <div>
                <label htmlFor="till-customer-name" className="mb-1 block">
                  {t("customerName")}
                </label>
                <input
                  id="till-customer-name"
                  className={inputClass}
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5"
                />
                <span>{t("marketingConsent")}</span>
              </label>
              <button
                type="button"
                className={buttonClass("secondary")}
                disabled={pending || !name.trim()}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const r = await add({ name, phone, marketingConsent: consent });
                    if (r.ok) {
                      setAdding(false);
                      onCustomer(r.data as unknown as TillCustomer);
                    } else setError(r.error);
                  })
                }
              >
                {t("addCustomer")}
              </button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </details>
  );
}

export interface TillGiftCard {
  code: string;
  last4: string;
  balance: string;
}

/** Pay all or part of the order from a gift card (its balance is checked online). */
export function GiftCardPay({
  online,
  check,
  onApply,
}: {
  online: boolean;
  check: (code: string) => Promise<Result>;
  onApply: (g: TillGiftCard) => void;
}) {
  const t = useTranslations("pos");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!online) return <p className="text-muted text-sm">{t("needsConnection")}</p>;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="till-gift-code" className="mb-1 block">
            {t("giftCardCode")}
          </label>
          <input
            id="till-gift-code"
            className={inputClass}
            inputMode="numeric"
            dir="ltr"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <button
          type="button"
          className={buttonClass("secondary")}
          disabled={pending || code.replace(/\D/g, "").length !== 16}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await check(code);
              if (!r.ok) return setError(r.error);
              const d = r.data as { last4: string; balance: string; blocked: boolean };
              if (d.blocked) return setError(t("giftCardBlocked"));
              if (!new Decimal(d.balance).gt(0)) return setError(t("giftCardEmpty"));
              onApply({ code: code.replace(/\D/g, ""), last4: d.last4, balance: d.balance });
            })
          }
        >
          {t("applyGiftCard")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Sell a gift card at the till; its code is shown once, to print or hand over. */
export function SellGiftCard({
  online,
  sell,
  fmt,
}: {
  online: boolean;
  sell: (input: unknown) => Promise<Result>;
  fmt: (d: Decimal) => string;
}) {
  const t = useTranslations("pos");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "CARD">("CASH");
  const [sold, setSold] = useState<{ code: string; balance: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">{t("sellGiftCard")}</summary>
      {!online ? (
        <p className="text-muted mt-2">{t("needsConnection")}</p>
      ) : sold ? (
        <div
          role="status"
          className="border-success/40 bg-success-surface mt-2 rounded-md border p-3"
        >
          <p>{t("giftCardSold", { value: fmt(new Decimal(sold.balance)) })}</p>
          <p className="ltr-value my-2 font-mono text-xl" data-testid="gift-card-code">
            {formatGiftCardCode(sold.code)}
          </p>
          <p className="text-muted text-xs">{t("giftCardCodeOnce")}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => window.print()}
            >
              {t("print")}
            </button>
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => setSold(null)}
            >
              {t("done")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="gift-amount" className="mb-1 block">
                {t("giftCardValue")}
              </label>
              <input
                id="gift-amount"
                className={inputClass}
                inputMode="decimal"
                dir="ltr"
                value={amount}
                onChange={(e) => setAmount(e.target.value.trim())}
              />
            </div>
            <div>
              <label htmlFor="gift-method" className="mb-1 block">
                {t("paymentMethod")}
              </label>
              <select
                id="gift-method"
                className={inputClass}
                value={method}
                onChange={(e) => setMethod(e.target.value as "CASH" | "CARD")}
              >
                <option value="CASH">{t("methods.CASH")}</option>
                <option value="CARD">{t("methods.CARD")}</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            className={buttonClass("primary")}
            disabled={pending || !/^\d+(\.\d{1,2})?$/.test(amount)}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await sell({ amount, method });
                if (!r.ok) return setError(r.error);
                setAmount("");
                setSold(r.data as { code: string; balance: string });
              })
            }
          >
            {t("sellGiftCardFor", {
              value: /^\d+(\.\d+)?$/.test(amount) ? fmt(new Decimal(amount)) : "—",
            })}
          </button>
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </details>
  );
}
