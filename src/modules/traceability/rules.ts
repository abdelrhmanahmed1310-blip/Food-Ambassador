import { Decimal } from "@/lib/decimal";

/**
 * Lot trace analysis (DECISIONS.md ADR-033). Pure: classifies the ledger
 * entries of one lot into where it came from, where it left the business,
 * and internal moves, and reports gaps explicitly.
 */

export interface TraceEntry {
  id: string;
  movementType: string;
  warehouseId: string;
  quantityDelta: Decimal;
  occurredAt: Date;
  reversesEntryId: string | null;
}

/** Inbound movements that bring the lot into the business. */
const ORIGIN = new Set([
  "RECEIPT",
  "OPENING_BALANCE",
  "ADJUSTMENT",
  "COUNT_ADJUSTMENT",
  "PRODUCTION_OUTPUT",
  "CUSTOMER_RETURN",
]);
/** Outbound movements that take it out of the business. */
const EXIT = new Set([
  "WRITE_OFF",
  "ADJUSTMENT",
  "COUNT_ADJUSTMENT",
  "CONSUMPTION",
  "RETURN_TO_SUPPLIER",
]);
/** Origins that say nothing about where the goods came from. */
const SOURCELESS = new Set(["OPENING_BALANCE", "ADJUSTMENT", "COUNT_ADJUSTMENT"]);

export type GapKind = "ORIGIN_WITHOUT_SUPPLIER" | "UNLOTTED_USAGE";

export interface Gap {
  kind: GapKind;
  entryId: string;
  warehouseId: string;
  quantity: string;
}

export interface TraceSummary {
  origins: string[];
  exits: string[];
  internal: string[];
  received: Decimal;
  exited: Decimal;
  onHand: Decimal;
  /** Warehouses the lot has been in, first arrival time each. */
  warehouses: Map<string, Date>;
  gaps: Gap[];
}

/**
 * `unlotted` are outbound entries of the same product without a lot; those
 * in a warehouse that held this lot, at or after it arrived there, may be
 * this lot used without recording it — reported as gaps.
 */
export function summarizeTrace(
  entries: readonly TraceEntry[],
  unlotted: readonly TraceEntry[] = [],
): TraceSummary {
  const reversed = new Set(entries.flatMap((e) => (e.reversesEntryId ? [e.reversesEntryId] : [])));
  const summary: TraceSummary = {
    origins: [],
    exits: [],
    internal: [],
    received: new Decimal(0),
    exited: new Decimal(0),
    onHand: new Decimal(0),
    warehouses: new Map(),
    gaps: [],
  };
  const sorted = [...entries].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const e of sorted) {
    summary.onHand = summary.onHand.plus(e.quantityDelta);
    if (e.quantityDelta.gt(0) && !summary.warehouses.has(e.warehouseId))
      summary.warehouses.set(e.warehouseId, e.occurredAt);
    if (e.movementType === "REVERSAL" || reversed.has(e.id)) {
      summary.internal.push(e.id);
      continue;
    }
    if (e.quantityDelta.gt(0) && ORIGIN.has(e.movementType)) {
      summary.origins.push(e.id);
      summary.received = summary.received.plus(e.quantityDelta);
      if (SOURCELESS.has(e.movementType))
        summary.gaps.push({
          kind: "ORIGIN_WITHOUT_SUPPLIER",
          entryId: e.id,
          warehouseId: e.warehouseId,
          quantity: e.quantityDelta.toFixed(),
        });
    } else if (e.quantityDelta.lt(0) && EXIT.has(e.movementType)) {
      summary.exits.push(e.id);
      summary.exited = summary.exited.minus(e.quantityDelta);
    } else {
      summary.internal.push(e.id);
    }
  }
  for (const u of unlotted) {
    const arrived = summary.warehouses.get(u.warehouseId);
    if (u.quantityDelta.lt(0) && arrived && u.occurredAt >= arrived)
      summary.gaps.push({
        kind: "UNLOTTED_USAGE",
        entryId: u.id,
        warehouseId: u.warehouseId,
        quantity: u.quantityDelta.negated().toFixed(),
      });
  }
  return summary;
}
