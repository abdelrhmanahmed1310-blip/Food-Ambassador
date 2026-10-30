import DecimalJs from "decimal.js";
import { z } from "zod";

/**
 * Decimal arithmetic for quantities, costs and money. JavaScript numbers are
 * never used for these values; see DATA_MODEL.md § Numeric precision.
 *
 * Storage scales (PostgreSQL NUMERIC):
 *   quantity   NUMERIC(20, 6)
 *   unit cost  NUMERIC(20, 6)
 *   money      NUMERIC(19, 4)
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30,
});
export type Decimal = InstanceType<typeof Decimal>;

export const QUANTITY_SCALE = 6;
export const UNIT_COST_SCALE = 6;
export const MONEY_SCALE = 4;

export type DecimalInput = Decimal | string | number | bigint;

export const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Convert to Decimal. Numbers are accepted only when they are safe integers,
 * because a fractional JS number (e.g. 0.1 + 0.2) may already carry
 * floating-point error. Pass fractional values as strings.
 */
export function toDecimal(value: DecimalInput): Decimal {
  if (value instanceof Decimal || DecimalJs.isDecimal(value)) return new Decimal(value as Decimal);
  if (typeof value === "bigint") return new Decimal(value.toString());
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `Refusing to convert non-integer number ${value} to Decimal; pass a string`,
      );
    }
    return new Decimal(value);
  }
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new TypeError(`Invalid decimal string: "${value}"`);
  }
  return new Decimal(trimmed);
}

export function scaleOf(value: Decimal): number {
  return value.decimalPlaces();
}

export function roundTo(value: DecimalInput, scale: number): Decimal {
  return toDecimal(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
}

export const roundQuantity = (value: DecimalInput) => roundTo(value, QUANTITY_SCALE);
export const roundUnitCost = (value: DecimalInput) => roundTo(value, UNIT_COST_SCALE);
export const roundMoney = (value: DecimalInput) => roundTo(value, MONEY_SCALE);

export function sum(values: readonly DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0));
}

/**
 * Allocate `total` across `weights` proportionally, rounding each share to
 * `scale` and assigning the rounding remainder to the largest-weight line so
 * that shares always sum exactly to the rounded total (used later for
 * landed-cost allocation).
 */
export function allocateProportionally(
  total: DecimalInput,
  weights: readonly DecimalInput[],
  scale: number = MONEY_SCALE,
): Decimal[] {
  if (weights.length === 0) throw new RangeError("At least one weight is required");
  const w = weights.map(toDecimal);
  if (w.some((x) => x.isNegative())) throw new RangeError("Weights must not be negative");
  const weightTotal = sum(w);
  if (weightTotal.isZero()) throw new RangeError("Weights must not all be zero");

  const target = roundTo(total, scale);
  const shares = w.map((x) =>
    target.times(x).dividedBy(weightTotal).toDecimalPlaces(scale, Decimal.ROUND_DOWN),
  );
  const remainder = target.minus(sum(shares));
  let largest = 0;
  for (let i = 1; i < w.length; i++) if (w[i].greaterThan(w[largest])) largest = i;
  shares[largest] = shares[largest].plus(remainder);
  return shares;
}

/**
 * Zod schema for decimal values arriving as strings from forms, CSV and the API.
 * Output is a normalized string (safe to pass to Prisma's Decimal columns).
 * Error messages are translation keys (validation.*).
 */
export function decimalString(options: {
  maxScale: number;
  min?: DecimalInput;
  max?: DecimalInput;
  allowNegative?: boolean;
}) {
  return z
    .string()
    .trim()
    .regex(DECIMAL_PATTERN, { error: "invalidDecimal" })
    .superRefine((raw, ctx) => {
      // Zod keeps running refinements after the regex fails; skip malformed input.
      if (!DECIMAL_PATTERN.test(raw)) return;
      const value = new Decimal(raw);
      if (value.decimalPlaces() > options.maxScale) {
        ctx.addIssue({ code: "custom", message: "tooManyDecimals" });
      }
      if (!options.allowNegative && value.isNegative() && !value.isZero()) {
        ctx.addIssue({ code: "custom", message: "mustNotBeNegative" });
      }
      if (
        options.min !== undefined &&
        value.lessThan(toDecimal(options.min)) &&
        !(value.isNegative() && !options.allowNegative)
      ) {
        // Minimums are 0 (non-negative), the smallest positive step, or a negative bound.
        const min = toDecimal(options.min);
        ctx.addIssue({
          code: "custom",
          message: min.isZero()
            ? "mustNotBeNegative"
            : min.isNegative()
              ? "belowMinimum"
              : "mustBePositive",
        });
      }
      if (options.max !== undefined && value.greaterThan(toDecimal(options.max))) {
        ctx.addIssue({ code: "custom", message: "aboveMaximum" });
      }
    })
    .transform((raw) => new Decimal(raw).toFixed());
}
