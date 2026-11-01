import { Decimal } from "@/lib/decimal";
import { roundToCurrency, taxFromGross } from "@/modules/tax/rules";

/**
 * Discounts and promotions (DECISIONS.md ADR-067). Pure; shared by the
 * server and the till so both reach the same total.
 *
 * Order of application per line: the promotion's percentage first, then the
 * order discount (manual or coupon) spread over the lines in proportion to
 * what is left. Each line's VAT is then taken out of its discounted amount,
 * so the taxable amount falls with the discount.
 */

export interface PromotionRule {
  id: string;
  name: string;
  /** Percent off, e.g. 20 for 20 %. */
  percent: Decimal;
  categoryIds: string[];
  itemIds: string[];
  /** Empty = every channel. */
  channels: string[];
  /** ISO weekdays 1 (Monday) … 7; empty = every day. */
  weekdays: number[];
  /** "HH:MM" local; both null = all day. An end before the start crosses midnight. */
  startTime: string | null;
  endTime: string | null;
  validFrom: string;
  validTo: string | null;
}

export interface SaleMoment {
  channel: string;
  /** Local business date and time at the branch. */
  date: string;
  time: string;
  weekday: number;
}

const inWindow = (time: string, start: string | null, end: string | null) => {
  if (!start || !end) return true;
  const t = time.slice(0, 5);
  return start <= end ? t >= start && t < end : t >= start || t < end;
};

/** The best promotion for an item at that moment (highest percent), or null. */
export function promotionFor(
  item: { id: string; categoryId: string },
  at: SaleMoment,
  promotions: readonly PromotionRule[],
): PromotionRule | null {
  let best: PromotionRule | null = null;
  for (const p of promotions) {
    if (!p.itemIds.includes(item.id) && !p.categoryIds.includes(item.categoryId)) continue;
    if (p.channels.length > 0 && !p.channels.includes(at.channel)) continue;
    if (p.weekdays.length > 0 && !p.weekdays.includes(at.weekday)) continue;
    if (at.date < p.validFrom || (p.validTo !== null && at.date > p.validTo)) continue;
    if (!inWindow(at.time, p.startTime, p.endTime)) continue;
    if (!best || p.percent.gt(best.percent)) best = p;
  }
  return best;
}

export type OrderDiscount = { kind: "PERCENT" | "AMOUNT"; value: Decimal };

export interface PricedLine {
  /** Before any discount, as priced from the menu. */
  gross: Decimal;
  /** VAT rate, or null when VAT does not apply. */
  rate: Decimal | null;
  /** Percent off from a promotion, if any. */
  promoPercent: Decimal | null;
}

export interface DiscountedLine {
  discount: Decimal;
  promoDiscount: Decimal;
  gross: Decimal;
  net: Decimal;
  tax: Decimal;
}

/**
 * Apply promotions and an order discount. The order discount never takes a
 * line below zero; an amount larger than the order is capped at the order.
 */
export function applyDiscounts(
  lines: readonly PricedLine[],
  order: OrderDiscount | null,
  currency: string,
): { lines: DiscountedLine[]; orderDiscount: Decimal; promoDiscount: Decimal } {
  const zero = new Decimal(0);
  const afterPromo = lines.map((l) => {
    const promo = l.promoPercent
      ? roundToCurrency(l.gross.times(l.promoPercent).div(100), currency)
      : zero;
    return { ...l, promo, rest: l.gross.minus(promo) };
  });
  const base = afterPromo.reduce((a, l) => a.plus(l.rest), zero);
  let wanted = zero;
  if (order && base.gt(0)) {
    wanted =
      order.kind === "PERCENT"
        ? roundToCurrency(base.times(Decimal.min(order.value, 100)).div(100), currency)
        : Decimal.min(roundToCurrency(order.value, currency), base);
  }
  // Spread in proportion to each line's remaining amount; the last line with an amount takes the remainder.
  const lastIndex = afterPromo.map((l) => l.rest.gt(0)).lastIndexOf(true);
  let left = wanted;
  const out = afterPromo.map((l, i) => {
    let share = zero;
    if (wanted.gt(0) && l.rest.gt(0)) {
      share =
        i === lastIndex
          ? left
          : Decimal.min(roundToCurrency(wanted.times(l.rest).div(base), currency), left);
      left = left.minus(share);
    }
    const gross = l.rest.minus(share);
    const split = l.rate ? taxFromGross(gross, l.rate, currency) : { net: gross, tax: zero, gross };
    return {
      discount: l.promo.plus(share),
      promoDiscount: l.promo,
      gross: split.gross,
      net: split.net,
      tax: split.tax,
    };
  });
  return {
    lines: out,
    orderDiscount: wanted,
    promoDiscount: out.reduce((a, l) => a.plus(l.promoDiscount), zero),
  };
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The local date, time and ISO weekday of an instant at a branch, for promotions. */
export function saleMoment(channel: string, timeZone: string, at: Date): SaleMoment {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    channel,
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: WEEKDAYS[get("weekday")],
  };
}
