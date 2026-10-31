import { Decimal, MONEY_SCALE, roundMoney, roundQuantity } from "@/lib/decimal";

/** Pure purchasing rules (DECISIONS.md ADR-023). Unit-tested; services apply them under locks. */

export const PO_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CLOSED",
  "CANCELLED",
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/** Only drafts can be edited; everything after submission is fixed. */
export const isEditable = (status: PoStatus) => status === "DRAFT";
export const isReceivable = (status: PoStatus) =>
  status === "APPROVED" || status === "PARTIALLY_RECEIVED";
/** Cancel is for orders nothing has been received against. */
export const isCancellable = (status: PoStatus, hasReceipts: boolean) =>
  !hasReceipts && (status === "DRAFT" || status === "PENDING_APPROVAL" || status === "APPROVED");
/** Close ends an order early ("short close") once nothing more is expected. */
export const isClosable = (status: PoStatus) =>
  status === "APPROVED" || status === "PARTIALLY_RECEIVED";

export function lineTotal(quantity: Decimal, unitPrice: Decimal): Decimal {
  return roundMoney(quantity.times(unitPrice));
}

/**
 * What submitting an order does. With no threshold, or a total at or below
 * it, the order is approved at once; above it, another user must approve.
 */
export function approvalOutcome(
  total: Decimal,
  threshold: Decimal | null,
): "AUTO_APPROVED" | "NEEDS_APPROVAL" {
  if (threshold === null) return "AUTO_APPROVED";
  return total.greaterThan(threshold) ? "NEEDS_APPROVAL" : "AUTO_APPROVED";
}

export type ApprovalLevel = "BRANCH" | "HEAD_OFFICE" | "ANY";

/**
 * The approval steps an order above the limit goes through (ADR-049): the
 * branch steps, then head office. With neither configured, one approval by
 * any approver of the order's site (the ADR-023 rule).
 */
export function approvalChain(policy: {
  branchApprovalSteps: number;
  headOfficeApproval: boolean;
}): ApprovalLevel[] {
  const steps: ApprovalLevel[] = Array.from(
    { length: policy.branchApprovalSteps },
    () => "BRANCH" as const,
  );
  if (policy.headOfficeApproval) steps.push("HEAD_OFFICE");
  return steps.length > 0 ? steps : ["ANY"];
}

/** Level of step `given + 1`, or null when the chain is complete. */
export function nextApprovalLevel(
  chain: readonly ApprovalLevel[],
  given: number,
): ApprovalLevel | null {
  return given < chain.length ? chain[given] : null;
}

type ApproverGrant = {
  permission: string;
  scope:
    | { type: "ORGANIZATION" }
    | { type: "BRANCH"; branchId: string }
    | { type: "WAREHOUSE"; warehouseId: string };
};

/**
 * Whether these grants may sign a step at `level` for an order of this site.
 * BRANCH needs `purchasing.approve` granted for the order's branch or
 * warehouse itself (an organization-wide grant does not count — it is head
 * office); HEAD_OFFICE needs it organization-wide; ANY accepts either.
 */
export function holdsApprovalLevel(
  grants: readonly ApproverGrant[],
  level: ApprovalLevel,
  site: { branchId: string; warehouseId: string },
): boolean {
  return grants.some((g) => {
    if (g.permission !== "purchasing.approve") return false;
    const local =
      (g.scope.type === "BRANCH" && g.scope.branchId === site.branchId) ||
      (g.scope.type === "WAREHOUSE" && g.scope.warehouseId === site.warehouseId);
    const headOffice = g.scope.type === "ORGANIZATION";
    return level === "BRANCH" ? local : level === "HEAD_OFFICE" ? headOffice : local || headOffice;
  });
}

/** Most that may be accepted against a line: ordered × (1 + tolerance), in the base unit. */
export function maxAcceptable(orderedBase: Decimal, tolerance: Decimal): Decimal {
  if (tolerance.lt(0) || tolerance.gt(1)) throw new RangeError("Tolerance must be between 0 and 1");
  return roundQuantity(orderedBase.times(new Decimal(1).plus(tolerance)));
}

/** Order status implied by how much of each line has been accepted. */
export function statusFromReceipts(
  lines: ReadonlyArray<{ orderedBase: Decimal; receivedBase: Decimal }>,
): "APPROVED" | "PARTIALLY_RECEIVED" | "RECEIVED" {
  if (lines.every((l) => l.receivedBase.isZero())) return "APPROVED";
  return lines.every((l) => l.receivedBase.greaterThanOrEqualTo(l.orderedBase))
    ? "RECEIVED"
    : "PARTIALLY_RECEIVED";
}

/** Fraction of ordered quantity still open (0 when fully received), per line. */
export function openQuantity(orderedBase: Decimal, receivedBase: Decimal): Decimal {
  return Decimal.max(orderedBase.minus(receivedBase), 0);
}

export interface PerformanceInput {
  /** One row per posted (not reversed) receipt. */
  receipts: ReadonlyArray<{
    receivedOn: string;
    expectedOn: string | null;
    receivedBase: Decimal;
    acceptedBase: Decimal;
    rejectedBase: Decimal;
    /** Σ (charged − ordered price) × accepted quantity. */
    priceVariance: Decimal;
  }>;
  /** Orders that are finished (received or closed): ordered and accepted base quantities. */
  finishedOrders: ReadonlyArray<{ orderedBase: Decimal; acceptedBase: Decimal }>;
}

export interface Performance {
  receipts: number;
  /** null when no receipt had an expected date. */
  onTimeRate: Decimal | null;
  /** Accepted ÷ ordered over finished orders, capped at 1; null without finished orders. */
  fillRate: Decimal | null;
  /** Rejected ÷ received; null without receipts. */
  rejectionRate: Decimal | null;
  priceVariance: Decimal;
}

/**
 * Supplier scorecard from real receipts only. Rates are fractions 0–1 and
 * are null (not 0 or 100 %) when there is nothing to measure.
 */
export function supplierPerformance(input: PerformanceInput): Performance {
  const dated = input.receipts.filter((r) => r.expectedOn !== null);
  const onTime = dated.filter((r) => r.receivedOn <= (r.expectedOn as string)).length;
  const received = input.receipts.reduce((a, r) => a.plus(r.receivedBase), new Decimal(0));
  const rejected = input.receipts.reduce((a, r) => a.plus(r.rejectedBase), new Decimal(0));
  const ordered = input.finishedOrders.reduce((a, o) => a.plus(o.orderedBase), new Decimal(0));
  const accepted = input.finishedOrders.reduce(
    (a, o) => a.plus(Decimal.min(o.acceptedBase, o.orderedBase)),
    new Decimal(0),
  );
  return {
    receipts: input.receipts.length,
    onTimeRate: dated.length === 0 ? null : new Decimal(onTime).dividedBy(dated.length),
    fillRate: ordered.isZero() ? null : accepted.dividedBy(ordered),
    rejectionRate: received.isZero() ? null : rejected.dividedBy(received),
    priceVariance: input.receipts.reduce((a, r) => a.plus(r.priceVariance), new Decimal(0)),
  };
}

export interface ReorderInput {
  /** All in the product's base unit. */
  minBase: Decimal;
  maxBase: Decimal;
  /** Usable stock: available, not expired, not on recall hold. */
  availableBase: Decimal;
  /** Still to arrive on open orders (draft, pending, approved, partly received). */
  onOrderBase: Decimal;
  /** Base units in one purchase unit (e.g. 30 for a case of 30 eggs). */
  basePerPurchaseUnit: Decimal;
  /** Supplier's minimum order, in purchase units. */
  minOrderPurchaseUnits: Decimal | null;
}

/**
 * Suggested order for a reorder rule (par level): when available plus
 * on-order stock is at or below the minimum, order up to the maximum, in
 * whole purchase units (rounded up), and at least the supplier's minimum.
 * Returns null when nothing needs ordering.
 */
export function suggestReorder(
  input: ReorderInput,
): { purchaseUnits: Decimal; base: Decimal; projectedBase: Decimal } | null {
  if (!input.basePerPurchaseUnit.gt(0)) throw new RangeError("Unit factor must be positive");
  const projected = input.availableBase.plus(input.onOrderBase);
  if (projected.greaterThan(input.minBase)) return null;
  const need = input.maxBase.minus(projected);
  if (!need.gt(0)) return null;
  let units = need.dividedBy(input.basePerPurchaseUnit).toDecimalPlaces(0, Decimal.ROUND_UP);
  if (input.minOrderPurchaseUnits && units.lessThan(input.minOrderPurchaseUnits))
    units = input.minOrderPurchaseUnits;
  return {
    purchaseUnits: units,
    base: roundQuantity(units.times(input.basePerPurchaseUnit)),
    projectedBase: projected,
  };
}

/**
 * Split a landed cost over receipt lines in proportion to `weights`
 * (line value or quantity, ADR-028), at money scale, so the shares add up to
 * the amount exactly: each share is rounded down and the remaining 0.0001s
 * go to the largest remainders (earlier lines first on ties).
 */
export function allocateCharge(amount: Decimal, weights: readonly Decimal[]): Decimal[] {
  if (!amount.gt(0)) throw new RangeError("Amount must be positive");
  if (weights.some((w) => w.lt(0))) throw new RangeError("Weights must not be negative");
  const total = weights.reduce((a, w) => a.plus(w), new Decimal(0));
  if (!total.gt(0)) throw new RangeError("Nothing to allocate over");
  const unit = new Decimal(1).dividedBy(new Decimal(10).pow(MONEY_SCALE));
  const exact = weights.map((w) => amount.times(w).dividedBy(total));
  const shares = exact.map((e) => e.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_DOWN));
  let left = amount
    .minus(shares.reduce((a, s) => a.plus(s), new Decimal(0)))
    .dividedBy(unit)
    .toNumber();
  const order = exact
    .map((e, i) => ({ i, rest: e.minus(shares[i]) }))
    .sort((a, b) => b.rest.comparedTo(a.rest) || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] = shares[i].plus(unit);
    left -= 1;
  }
  return shares;
}

// ─── Purchase requisitions (ADR-029) ───

export const REQUISITION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "PARTIALLY_ORDERED",
  "ORDERED",
  "REJECTED",
  "CLOSED",
  "CANCELLED",
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

/** Status of a submitted requisition implied by how many of its lines are on orders. */
export function requisitionStatusFromLines(
  ordered: number,
  total: number,
): "SUBMITTED" | "PARTIALLY_ORDERED" | "ORDERED" {
  if (ordered === 0) return "SUBMITTED";
  return ordered >= total ? "ORDERED" : "PARTIALLY_ORDERED";
}

export const requisitionActions = (status: RequisitionStatus, ordered: number) => ({
  /** Requester side. */
  edit: status === "DRAFT",
  cancel: status === "DRAFT" || (status === "SUBMITTED" && ordered === 0),
  /** Buyer side. */
  order: status === "SUBMITTED" || status === "PARTIALLY_ORDERED",
  reject: status === "SUBMITTED" && ordered === 0,
  close: status === "PARTIALLY_ORDERED",
});
