"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { Decimal } from "@/lib/decimal";
import { applyDiscounts, type PricedLine } from "@/modules/pos/discounts";

/** A discount on the whole order, chosen on the till or a check (ADR-067). */
export type DiscountChoice =
  | { type: "manual"; kind: "PERCENT" | "AMOUNT"; value: string; reason: string }
  | { type: "coupon"; code: string; kind: "PERCENT" | "AMOUNT"; value: string }
  | null;

type Lookup = (
  code: string,
) => Promise<{ ok: true; data?: Record<string, unknown> } | { ok: false; error: string }>;

/** The order as the server will price it: promotions first, then the order discount. */
export function priceWithDiscounts(lines: PricedLine[], choice: DiscountChoice, currency: string) {
  const r = applyDiscounts(
    lines,
    choice ? { kind: choice.kind, value: new Decimal(choice.value) } : null,
    currency,
  );
  const sum = (k: "gross" | "tax") => r.lines.reduce((a, l) => a.plus(l[k]), new Decimal(0));
  return { ...r, total: sum("gross"), tax: sum("tax") };
}

/** What the order request carries for the discount. */
export const discountPayload = (choice: DiscountChoice) =>
  choice?.type === "manual"
    ? { discount: { kind: choice.kind, value: choice.value, reason: choice.reason } }
    : choice?.type === "coupon"
      ? { couponCode: choice.code }
      : {};

const NUMBER = /^\d+(\.\d+)?$/;

export function DiscountPanel({
  idPrefix,
  canDiscount,
  choice,
  onChange,
  lookup,
}: {
  idPrefix: string;
  canDiscount: boolean;
  choice: DiscountChoice;
  onChange: (c: DiscountChoice) => void;
  lookup: Lookup;
}) {
  const t = useTranslations("pos");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (choice)
    return (
      <div
        className="flex items-center justify-between gap-2 text-sm"
        data-testid="discount-chosen"
      >
        <span>
          {choice.type === "coupon"
            ? t("couponApplied", { code: choice.code })
            : t("discountApplied", { reason: choice.reason })}
        </span>
        <button
          type="button"
          className="text-danger hover:underline"
          onClick={() => onChange(null)}
        >
          {t("removeDiscount")}
        </button>
      </div>
    );

  return (
    <details className="text-sm">
      <summary className="cursor-pointer">{t("discount")}</summary>
      <div className="mt-2 space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor={`${idPrefix}-coupon`} className="mb-1 block">
              {t("couponCode")}
            </label>
            <input
              id={`${idPrefix}-coupon`}
              className={inputClass}
              dir="ltr"
              maxLength={30}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </div>
          <button
            type="button"
            className={buttonClass("secondary")}
            disabled={pending || code.trim().length < 3}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const r = await lookup(code.trim());
                if (!r.ok) setError(r.error);
                else {
                  const d = r.data as { code: string; kind: "PERCENT" | "AMOUNT"; value: string };
                  onChange({ type: "coupon", code: d.code, kind: d.kind, value: d.value });
                }
              })
            }
          >
            {t("applyCoupon")}
          </button>
        </div>
        {canDiscount ? (
          <fieldset className="border-border space-y-2 rounded-md border p-2">
            <legend className="px-1">{t("manualDiscount")}</legend>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={`${idPrefix}-kind`} className="mb-1 block">
                  {t("discountKind")}
                </label>
                <select
                  id={`${idPrefix}-kind`}
                  className={inputClass}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "PERCENT" | "AMOUNT")}
                >
                  <option value="PERCENT">{t("discountKinds.PERCENT")}</option>
                  <option value="AMOUNT">{t("discountKinds.AMOUNT")}</option>
                </select>
              </div>
              <div>
                <label htmlFor={`${idPrefix}-value`} className="mb-1 block">
                  {t("discountValue")}
                </label>
                <input
                  id={`${idPrefix}-value`}
                  className={inputClass}
                  dir="ltr"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value.trim())}
                />
              </div>
            </div>
            <div>
              <label htmlFor={`${idPrefix}-reason`} className="mb-1 block">
                {t("discountReason")}
              </label>
              <input
                id={`${idPrefix}-reason`}
                className={inputClass}
                maxLength={120}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => {
                const ok =
                  NUMBER.test(value) &&
                  Number(value) > 0 &&
                  (kind === "AMOUNT" || Number(value) <= 100);
                if (!ok) return setError(t("discountInvalid"));
                if (!reason.trim()) return setError(t("discountNeedsReason"));
                setError(null);
                onChange({ type: "manual", kind, value, reason: reason.trim() });
              }}
            >
              {t("applyDiscount")}
            </button>
          </fieldset>
        ) : null}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
