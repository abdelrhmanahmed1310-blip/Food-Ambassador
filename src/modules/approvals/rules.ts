import { Decimal } from "@/lib/decimal";

/**
 * Approval matrix (DECISIONS.md ADR-049, Q-04/Q-12). Pure and unit-tested.
 *
 * An organization configures up to three branch layers and one head-office
 * layer per document type. Each layer has its own limit: it is required
 * when the document's amount is above that limit (0 = any amount). A
 * document's chain is the required layers in order, branch first.
 */

export type ApprovalLevel = "BRANCH" | "HEAD_OFFICE" | "ANY";
export type ApprovalDocument = "PURCHASE_ORDER" | "STOCK_COUNT";

/** Positions 1–3 are branch layers, 4 is head office. */
export const LAYER_POSITIONS = [1, 2, 3, 4] as const;
export const levelOfPosition = (position: number): "BRANCH" | "HEAD_OFFICE" =>
  position === 4 ? "HEAD_OFFICE" : "BRANCH";

export interface ApprovalLayer {
  position: number;
  /** Required when the amount is above this (base currency). */
  aboveAmount: Decimal;
}

/** The layers a document of this amount must pass, in order. Empty = no approval needed. */
export function chainFor(layers: readonly ApprovalLayer[], amount: Decimal): ApprovalLevel[] {
  return [...layers]
    .sort((a, b) => a.position - b.position)
    .filter((l) => amount.greaterThan(l.aboveAmount))
    .map((l) => levelOfPosition(l.position));
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
 * Whether these grants may sign a step at `level` for a document of this
 * site. BRANCH needs `permission` granted for the document's own branch or
 * warehouse (an organization-wide grant is head office and does not count);
 * HEAD_OFFICE needs it organization-wide; ANY accepts either.
 */
export function holdsApprovalLevel(
  grants: readonly ApproverGrant[],
  permission: string,
  level: ApprovalLevel,
  site: { branchId: string; warehouseId: string },
): boolean {
  return grants.some((g) => {
    if (g.permission !== permission) return false;
    const local =
      (g.scope.type === "BRANCH" && g.scope.branchId === site.branchId) ||
      (g.scope.type === "WAREHOUSE" && g.scope.warehouseId === site.warehouseId);
    const headOffice = g.scope.type === "ORGANIZATION";
    return level === "BRANCH" ? local : level === "HEAD_OFFICE" ? headOffice : local || headOffice;
  });
}

export type ApprovalBlock = "SELF" | "ALREADY_SIGNED" | "LEVEL";

/**
 * Why `userId` cannot sign the next step, or null if they can: they created
 * or submitted the document, signed earlier in this round, or do not hold
 * the step's level.
 */
export function approvalBlock(input: {
  userId: string;
  authors: ReadonlyArray<string | null>;
  signedThisRound: readonly string[];
  holdsLevel: boolean;
}): ApprovalBlock | null {
  if (input.authors.includes(input.userId)) return "SELF";
  if (input.signedThisRound.includes(input.userId)) return "ALREADY_SIGNED";
  return input.holdsLevel ? null : "LEVEL";
}
