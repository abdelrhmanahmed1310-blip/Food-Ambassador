import { Decimal, roundQuantity } from "@/lib/decimal";

/**
 * Transparent demand forecasts (DECISIONS.md ADR-120). Pure functions over a
 * daily demand series (oldest first, ending yesterday). Every method is one
 * a buyer can check by hand; the one used for an item is the one that would
 * have been most accurate over the last BACKTEST_DAYS days.
 */

export const FORECAST_METHODS = ["MOVING_AVERAGE_28", "MOVING_AVERAGE_7", "SAME_WEEKDAY"] as const;
export type ForecastMethod = (typeof FORECAST_METHODS)[number];

/** Days of history read for each item. */
export const HISTORY_DAYS = 56;
/** Days held out to score each method. */
export const BACKTEST_DAYS = 14;
/** Fewer days since the item was first stocked here gives no forecast. */
export const MIN_HISTORY_DAYS = 28;
/** Service levels offered, with their standard normal quantiles (one-sided). */
export const SERVICE_LEVELS = {
  "0.9": "1.2816",
  "0.95": "1.6449",
  "0.98": "2.0537",
  "0.99": "2.3263",
} as const;
export type ServiceLevel = keyof typeof SERVICE_LEVELS;

const ZERO = new Decimal(0);
const mean = (values: readonly Decimal[]) =>
  values.length === 0 ? ZERO : values.reduce((a, v) => a.plus(v), ZERO).dividedBy(values.length);

/**
 * Daily demand `ahead` days after the end of `history` (0 = the next day).
 * Averages use only the days available, so a short history still works.
 */
export function predict(method: ForecastMethod, history: readonly Decimal[], ahead = 0): Decimal {
  const n = history.length;
  if (n === 0) return ZERO;
  switch (method) {
    case "MOVING_AVERAGE_7":
      return mean(history.slice(-7));
    case "MOVING_AVERAGE_28":
      return mean(history.slice(-28));
    case "SAME_WEEKDAY": {
      // The same weekday in the last four weeks that are in the history.
      const days: Decimal[] = [];
      for (let back = 7 - (ahead % 7); days.length < 4 && n - back >= 0; back += 7)
        days.push(history[n - back]);
      return mean(days);
    }
  }
}

export interface Accuracy {
  method: ForecastMethod;
  /** Sum of absolute errors over actual demand; null when there was no demand. */
  wape: Decimal | null;
  /** Sum of (forecast − actual) over actual demand: positive means over-forecast. */
  bias: Decimal | null;
  /** Root mean square of the daily errors, in base units. */
  rmse: Decimal;
}

/** One-day-ahead forecasts for each of the last `days` days, from the days before it. */
export function backtest(
  method: ForecastMethod,
  series: readonly Decimal[],
  days = BACKTEST_DAYS,
): Accuracy {
  const start = Math.max(1, series.length - days);
  let actual = ZERO;
  let absError = ZERO;
  let error = ZERO;
  let squared = ZERO;
  let count = 0;
  for (let i = start; i < series.length; i++) {
    const f = predict(method, series.slice(0, i));
    const a = series[i];
    actual = actual.plus(a);
    absError = absError.plus(f.minus(a).abs());
    error = error.plus(f.minus(a));
    squared = squared.plus(f.minus(a).pow(2));
    count++;
  }
  return {
    method,
    wape: actual.gt(0) ? absError.dividedBy(actual) : null,
    bias: actual.gt(0) ? error.dividedBy(actual) : null,
    rmse: count ? squared.dividedBy(count).sqrt() : ZERO,
  };
}

export type ForecastResult =
  | { status: "SHORT_HISTORY"; historyDays: number }
  | {
      status: "OK";
      historyDays: number;
      method: ForecastMethod;
      accuracy: Accuracy;
      /** Every method's score, in FORECAST_METHODS order. */
      scores: Accuracy[];
      /** Forecast demand for each of the next `horizon` days. */
      daily: Decimal[];
    };

/**
 * Pick the method with the lowest WAPE over the backtest (ties: the earlier
 * method in FORECAST_METHODS, the steadier one; no demand in the backtest:
 * the lowest RMSE) and forecast the next `horizon` days with it.
 */
export function forecast(
  series: readonly Decimal[],
  historyDays: number,
  horizon = 28,
): ForecastResult {
  if (historyDays < MIN_HISTORY_DAYS) return { status: "SHORT_HISTORY", historyDays };
  const usable = series.slice(-Math.min(series.length, historyDays));
  const scores = FORECAST_METHODS.map((m) => backtest(m, usable));
  const best = scores.reduce((a, s) => {
    if (a.wape && s.wape) return s.wape.lt(a.wape) ? s : a;
    if (!a.wape && !s.wape) return s.rmse.lt(a.rmse) ? s : a;
    return a.wape ? a : s;
  });
  return {
    status: "OK",
    historyDays,
    method: best.method,
    accuracy: best,
    scores,
    daily: Array.from({ length: horizon }, (_, k) => predict(best.method, usable, k)),
  };
}

export interface ForecastOrderInput {
  /** Forecast daily demand from today (the day after the history), base units. */
  daily: readonly Decimal[];
  /** Daily forecast error (backtest RMSE), base units. */
  rmse: Decimal;
  leadTimeDays: number;
  reviewDays: number;
  serviceLevel: ServiceLevel;
  availableBase: Decimal;
  onOrderBase: Decimal;
  basePerPurchaseUnit: Decimal;
  minOrderPurchaseUnits: Decimal | null;
}

export interface ForecastOrder {
  /** Days the order must cover: lead time plus the review period. */
  coverDays: number;
  demandBase: Decimal;
  /** z × RMSE × √(cover days). */
  safetyBase: Decimal;
  targetBase: Decimal;
  projectedBase: Decimal;
  /** Null when stock on hand and on order already covers the target. */
  purchaseUnits: Decimal | null;
  base: Decimal | null;
}

/**
 * Order up to forecast demand over lead time and review period plus safety
 * stock, less stock available and on order, in whole purchase units.
 */
export function forecastOrder(input: ForecastOrderInput): ForecastOrder {
  if (!input.basePerPurchaseUnit.gt(0)) throw new RangeError("Unit factor must be positive");
  if (input.leadTimeDays < 0 || input.reviewDays < 1) throw new RangeError("Invalid cover");
  const coverDays = input.leadTimeDays + input.reviewDays;
  const days = Array.from(
    { length: coverDays },
    (_, k) => input.daily[k] ?? input.daily.at(-1) ?? ZERO,
  );
  const demandBase = roundQuantity(days.reduce((a, d) => a.plus(d), ZERO));
  const safetyBase = roundQuantity(
    new Decimal(SERVICE_LEVELS[input.serviceLevel])
      .times(input.rmse)
      .times(Decimal.sqrt(coverDays)),
  );
  const targetBase = demandBase.plus(safetyBase);
  const projectedBase = input.availableBase.plus(input.onOrderBase);
  const need = targetBase.minus(projectedBase);
  if (!need.gt(0))
    return {
      coverDays,
      demandBase,
      safetyBase,
      targetBase,
      projectedBase,
      purchaseUnits: null,
      base: null,
    };
  let units = need.dividedBy(input.basePerPurchaseUnit).toDecimalPlaces(0, Decimal.ROUND_UP);
  if (input.minOrderPurchaseUnits && units.lt(input.minOrderPurchaseUnits))
    units = input.minOrderPurchaseUnits;
  return {
    coverDays,
    demandBase,
    safetyBase,
    targetBase,
    projectedBase,
    purchaseUnits: units,
    base: roundQuantity(units.times(input.basePerPurchaseUnit)),
  };
}

/** Weekly totals of a daily series, the last week ending with the series. */
export function weeklyTotals(series: readonly Decimal[]): Decimal[] {
  const weeks: Decimal[] = [];
  for (let end = series.length; end > 0; end -= 7)
    weeks.unshift(series.slice(Math.max(0, end - 7), end).reduce((a, d) => a.plus(d), ZERO));
  return weeks;
}
