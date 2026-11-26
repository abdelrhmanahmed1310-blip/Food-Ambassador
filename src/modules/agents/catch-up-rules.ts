import { addDays } from "@/modules/inventory/rules";

/**
 * The daily close catches up (DECISIONS.md ADR-159). A scheduled run checks
 * every day since the last day it checked successfully, oldest first, up to
 * the last 7 days, skipping days already checked. With no earlier check it
 * checks yesterday only.
 */
export const CATCH_UP_DAYS = 7;

export function daysToCheck(
  yesterday: string,
  lastChecked: string | null,
  checked: ReadonlySet<string>,
): string[] {
  const earliest = addDays(yesterday, -(CATCH_UP_DAYS - 1));
  let day = lastChecked ? addDays(lastChecked, 1) : yesterday;
  if (day < earliest) day = earliest;
  const out: string[] = [];
  for (; day <= yesterday; day = addDays(day, 1)) if (!checked.has(day)) out.push(day);
  return out;
}
