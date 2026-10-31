import "server-only";
import { isCalendarDate } from "@/lib/dates";
import { businessDate } from "@/modules/inventory/rules";

/** Period from search params; defaults to the current month to date in the organization's time zone. */
export function reportPeriod(sp: Record<string, string | string[] | undefined>, timeZone: string) {
  const today = businessDate(timeZone);
  const from =
    typeof sp.from === "string" && isCalendarDate(sp.from) ? sp.from : `${today.slice(0, 7)}-01`;
  const to =
    typeof sp.to === "string" && isCalendarDate(sp.to) && sp.to >= from
      ? sp.to
      : today < from
        ? from
        : today;
  return { from, to };
}
