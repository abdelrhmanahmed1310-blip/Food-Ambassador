import { Decimal, roundMoney } from "@/lib/decimal";

/** Selling price, food cost % and margin rules (DECISIONS.md ADR-032). Pure. */

export type FoodCostStatus = "OK" | "ABOVE_TARGET" | "INCOMPLETE" | "NO_PRICE" | "NO_TARGET";

/** Cost ÷ price as a fraction (0.3 = 30 %), 4 dp. */
export function foodCostFraction(cost: Decimal, price: Decimal): Decimal {
  if (!price.gt(0)) throw new RangeError("Price must be positive");
  return cost.dividedBy(price).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/** Lowest price, rounded up to 0.01, at which the cost stays within the target. */
export function priceForTarget(cost: Decimal, target: Decimal): Decimal {
  if (!target.gt(0) || !target.lt(1)) throw new RangeError("Target must be between 0 and 1");
  return cost.dividedBy(target).toDecimalPlaces(2, Decimal.ROUND_UP);
}

export interface DishEconomics {
  costPerPortion: Decimal;
  missingCount: number;
  price: Decimal | null;
  target: Decimal | null;
}

/**
 * Classify a dish. An incomplete cost is never compared with the target
 * (it would look better than it is); without a price or a target there is
 * nothing to compare.
 */
export function dishEconomics(d: DishEconomics) {
  const margin = d.price ? roundMoney(d.price.minus(d.costPerPortion)) : null;
  const fraction = d.price ? foodCostFraction(d.costPerPortion, d.price) : null;
  const suggested =
    d.target && d.missingCount === 0 ? priceForTarget(d.costPerPortion, d.target) : null;
  let status: FoodCostStatus;
  if (d.missingCount > 0) status = "INCOMPLETE";
  else if (!d.price) status = "NO_PRICE";
  else if (!d.target) status = "NO_TARGET";
  else status = (fraction as Decimal).gt(d.target) ? "ABOVE_TARGET" : "OK";
  return { margin, fraction, suggested, status };
}
