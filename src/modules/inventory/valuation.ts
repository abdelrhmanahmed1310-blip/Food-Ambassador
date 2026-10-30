import { Decimal, roundMoney, roundUnitCost } from "@/lib/decimal";

/**
 * Moving weighted average costing (DECISIONS.md ADR-021). Pure functions over
 * the valuation of one product in one warehouse; the posting engine applies
 * them under row locks and the M3 migration's backfill mirrors them in SQL.
 */

export type CostSource = "ENTERED" | "AVERAGE" | "TRANSFER" | "RESTORED" | "NONE";

export interface ValuationState {
  quantity: Decimal;
  totalValue: Decimal;
  /**
   * Current average, or the last reliable one when quantity is zero or
   * uncosted units are on hand (null if never known).
   */
  averageUnitCost: Decimal | null;
  costMissing: boolean;
}

export interface CostedMovement {
  unitCost: Decimal | null;
  valueDelta: Decimal;
  costSource: CostSource;
  state: ValuationState;
}

export type InboundCost =
  /** Cost entered with the movement, per base unit. */
  | { kind: "entered"; unitCost: Decimal }
  /** Value of the outbound leg in the same document (transfer, status change). */
  | { kind: "transfer"; value: Decimal; unitCost: Decimal | null; costMissing: boolean }
  /** Put back exactly what an outbound entry took (reversal). */
  | { kind: "restore"; value: Decimal; unitCost: Decimal | null }
  /** No cost of its own: use the current or last known average. */
  | { kind: "average" };

/** Negate without producing -0 (decimal.js treats -0 as negative). */
export const negate = (v: Decimal): Decimal => (v.isZero() ? new Decimal(0) : v.negated());

export const emptyValuation = (): ValuationState => ({
  quantity: new Decimal(0),
  totalValue: new Decimal(0),
  averageUnitCost: null,
  costMissing: false,
});

function settle(
  previous: ValuationState,
  quantity: Decimal,
  totalValue: Decimal,
  costMissing: boolean,
): ValuationState {
  if (quantity.isZero()) {
    // Nothing on hand: no value and nothing uncosted; keep the last average.
    return {
      quantity,
      totalValue: new Decimal(0),
      averageUnitCost: previous.averageUnitCost,
      costMissing: false,
    };
  }
  return {
    quantity,
    totalValue,
    // With uncosted units on hand, value ÷ quantity understates the cost, so it
    // is not recorded as the average: the last reliable average (or none) stays.
    averageUnitCost: costMissing
      ? previous.averageUnitCost
      : roundUnitCost(totalValue.dividedBy(quantity)),
    costMissing,
  };
}

/**
 * Stock leaving at the current average. The last unit out takes the exact
 * remaining value, so value is zero whenever quantity is zero and never
 * negative. `quantity` is positive.
 */
export function costOutbound(state: ValuationState, quantity: Decimal): CostedMovement {
  if (!quantity.gt(0)) throw new RangeError("Outbound quantity must be positive");
  if (quantity.greaterThan(state.quantity)) throw new RangeError("Outbound exceeds valued stock");
  const value = quantity.equals(state.quantity)
    ? state.totalValue
    : roundMoney(quantity.times(state.totalValue).dividedBy(state.quantity));
  const remaining = state.quantity.minus(quantity);
  return {
    unitCost: roundUnitCost(state.totalValue.dividedBy(state.quantity)),
    valueDelta: negate(value),
    costSource: "AVERAGE",
    state: settle(state, remaining, state.totalValue.minus(value), state.costMissing),
  };
}

/**
 * Reversal of an inbound entry: take out the value that entry brought in, so
 * correcting a wrong price leaves the rest of the stock at its true value.
 * Capped at the value on hand; if the cap is hit while units remain, those
 * units are left at zero value and flagged cost missing (never negative).
 * `originalValue` is the positive value the inbound entry added.
 */
export function costInboundReversal(
  state: ValuationState,
  quantity: Decimal,
  originalValue: Decimal,
): CostedMovement {
  if (!quantity.gt(0)) throw new RangeError("Outbound quantity must be positive");
  if (quantity.greaterThan(state.quantity)) throw new RangeError("Outbound exceeds valued stock");
  if (originalValue.lt(0)) throw new RangeError("Original value must not be negative");
  const remaining = state.quantity.minus(quantity);
  const value = remaining.isZero()
    ? state.totalValue
    : Decimal.min(originalValue, state.totalValue);
  const exhausted =
    !remaining.isZero() && value.equals(state.totalValue) && originalValue.gt(value);
  return {
    unitCost: roundUnitCost(value.dividedBy(quantity)),
    valueDelta: negate(value),
    costSource: "RESTORED",
    state: settle(state, remaining, state.totalValue.minus(value), state.costMissing || exhausted),
  };
}

/** Stock arriving. `quantity` is positive. */
export function costInbound(
  state: ValuationState,
  quantity: Decimal,
  cost: InboundCost,
): CostedMovement {
  if (!quantity.gt(0)) throw new RangeError("Inbound quantity must be positive");
  let unitCost: Decimal | null;
  let value: Decimal;
  let costSource: CostSource;
  let costMissing = state.costMissing;
  switch (cost.kind) {
    case "entered":
      if (cost.unitCost.lt(0)) throw new RangeError("Unit cost must not be negative");
      unitCost = cost.unitCost;
      value = roundMoney(quantity.times(cost.unitCost));
      costSource = "ENTERED";
      break;
    case "transfer":
      unitCost = cost.unitCost;
      value = cost.value;
      costSource = "TRANSFER";
      costMissing ||= cost.costMissing;
      break;
    case "restore":
      unitCost = cost.unitCost;
      value = cost.value;
      costSource = "RESTORED";
      break;
    case "average":
      if (state.costMissing) {
        // The average is not reliable while uncosted units are on hand.
        unitCost = null;
        value = new Decimal(0);
        costSource = "NONE";
      } else if (state.quantity.gt(0)) {
        unitCost = roundUnitCost(state.totalValue.dividedBy(state.quantity));
        value = roundMoney(quantity.times(state.totalValue).dividedBy(state.quantity));
        costSource = "AVERAGE";
      } else if (state.averageUnitCost !== null) {
        unitCost = state.averageUnitCost;
        value = roundMoney(quantity.times(state.averageUnitCost));
        costSource = "AVERAGE";
      } else {
        // Never guess a cost: value it at zero and flag it (ADR-021).
        unitCost = null;
        value = new Decimal(0);
        costSource = "NONE";
        costMissing = true;
      }
      break;
  }
  if (value.lt(0)) throw new RangeError("Inbound value must not be negative");
  return {
    unitCost,
    valueDelta: value,
    costSource,
    state: settle(state, state.quantity.plus(quantity), state.totalValue.plus(value), costMissing),
  };
}

/** Set a new average for the stock on hand. Clears the cost-missing flag. */
export function revalue(
  state: ValuationState,
  newUnitCost: Decimal,
): { valueDelta: Decimal; state: ValuationState } {
  if (newUnitCost.lt(0)) throw new RangeError("Unit cost must not be negative");
  const cost = roundUnitCost(newUnitCost);
  const newValue = roundMoney(state.quantity.times(cost));
  return {
    valueDelta: newValue.minus(state.totalValue),
    state: {
      quantity: state.quantity,
      totalValue: newValue,
      averageUnitCost: cost,
      costMissing: false,
    },
  };
}

/**
 * Add a landed cost allocated to `receivedBase` units of one receipt
 * (DECISIONS.md ADR-028). Only the share for units still on hand is added
 * to the value — min(on hand, received) ÷ received of it; the rest relates to
 * stock already used and is returned as `expensed`. Quantity never changes.
 */
export function addLandedCost(
  state: ValuationState,
  allocated: Decimal,
  receivedBase: Decimal,
): { capitalized: Decimal; expensed: Decimal; state: ValuationState } {
  if (allocated.lt(0)) throw new RangeError("Allocated amount must not be negative");
  if (!receivedBase.gt(0)) throw new RangeError("Received quantity must be positive");
  const onHand = Decimal.min(state.quantity, receivedBase);
  const capitalized = onHand.gt(0)
    ? roundMoney(allocated.times(onHand).dividedBy(receivedBase))
    : new Decimal(0);
  const expensed = allocated.minus(capitalized);
  if (capitalized.isZero()) return { capitalized, expensed, state };
  return {
    capitalized,
    expensed,
    state: settle(state, state.quantity, state.totalValue.plus(capitalized), state.costMissing),
  };
}
