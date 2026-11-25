import { addDays } from "@/modules/inventory/rules";
import type { AgentKindCode } from "./rules";

/**
 * The weekly agent digest (DECISIONS.md ADR-153). Pure: which week a Monday
 * reports on, and the figures one person gets, summed over the agents they
 * may see. Counted from records, never estimated.
 */

/** Monday is 1, as in ISO weeks. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Monday-to-Sunday week before a Monday, or null on other days. */
export function previousWeek(monday: string): { from: string; to: string } | null {
  if (isoWeekday(monday) !== 1) return null;
  return { from: addDays(monday, -7), to: addDays(monday, -1) };
}

/** The Monday of the week a date falls in. */
export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** The first Monday after a date (for tests and previews). */
export function nextMonday(date: string): string {
  return addDays(date, 8 - isoWeekday(date));
}

export interface WeekFigures {
  runs: number;
  failedRuns: number;
  critical: number;
  proposals: number;
  approved: number;
  rejected: number;
  acted: number;
}

export const emptyWeek = (): WeekFigures => ({
  runs: 0,
  failedRuns: 0,
  critical: 0,
  proposals: 0,
  approved: 0,
  rejected: 0,
  acted: 0,
});

/**
 * One person's digest: the week's figures of the agents they may see, and
 * the proposals waiting for them now. Null when there is nothing to tell.
 */
export function digestFor(
  byKind: ReadonlyMap<AgentKindCode, WeekFigures>,
  kinds: readonly AgentKindCode[],
  waiting: number,
): (WeekFigures & { waiting: number }) | null {
  const sum = emptyWeek();
  for (const k of kinds) {
    const w = byKind.get(k);
    if (!w) continue;
    for (const key of Object.keys(sum) as Array<keyof WeekFigures>) sum[key] += w[key];
  }
  const quiet = Object.values(sum).every((v) => v === 0) && waiting === 0;
  return quiet ? null : { ...sum, waiting };
}
