import { Decimal, type DecimalInput } from "@/lib/decimal";

/**
 * Mock recall outcome (DECISIONS.md ADR-100). Pure. A drill passes when
 * the lot is fully accounted for (left the business + found = received),
 * the stock found matches the book, the trace has no gaps, the origin is
 * known and — when a target was set — the clock stayed within it.
 */

export type MockRecallProblem =
  "TARGET_MISSED" | "STOCK_DIFFERENCE" | "NOT_ACCOUNTED" | "TRACE_GAPS" | "ORIGIN_UNKNOWN";

export interface MockRecallFacts {
  received: DecimalInput;
  exited: DecimalInput;
  book: DecimalInput;
  found: DecimalInput;
  gapCount: number;
  /** A supplier receipt or a production order is known for the lot. */
  originKnown: boolean;
  elapsedSeconds: number;
  targetMinutes: number | null;
}

export interface MockRecallOutcome {
  /** (left the business + found) / received × 100, two decimals; null when nothing was received. */
  accountedPercent: Decimal | null;
  /** Found minus book; negative means stock missing. */
  difference: Decimal;
  withinTarget: boolean | null;
  problems: MockRecallProblem[];
}

export function mockRecallOutcome(f: MockRecallFacts): MockRecallOutcome {
  const received = new Decimal(f.received);
  const exited = new Decimal(f.exited);
  const found = new Decimal(f.found);
  const difference = found.minus(new Decimal(f.book));
  const accountedPercent = received.gt(0)
    ? exited.plus(found).div(received).times(100).toDecimalPlaces(2)
    : null;
  const withinTarget = f.targetMinutes === null ? null : f.elapsedSeconds <= f.targetMinutes * 60;
  const problems: MockRecallProblem[] = [];
  if (withinTarget === false) problems.push("TARGET_MISSED");
  if (!difference.isZero()) problems.push("STOCK_DIFFERENCE");
  if (accountedPercent !== null && !accountedPercent.eq(100)) problems.push("NOT_ACCOUNTED");
  if (f.gapCount > 0) problems.push("TRACE_GAPS");
  if (!f.originKnown) problems.push("ORIGIN_UNKNOWN");
  return { accountedPercent, difference, withinTarget, problems };
}

/** Elapsed time as hours and minutes, e.g. 125 min → { hours: 2, minutes: 5 }. */
export function splitElapsed(seconds: number): { hours: number; minutes: number } {
  const minutes = Math.floor(Math.max(seconds, 0) / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
