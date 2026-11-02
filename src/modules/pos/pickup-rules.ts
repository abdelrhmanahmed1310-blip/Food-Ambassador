/**
 * Guest order fulfilment rules (DECISIONS.md ADR-071). Pure; shared by the
 * server, the guest page and the staff list.
 */

/** Minutes the wall clock of `timeZone` is ahead of UTC at `instant`. */
function offsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((wall - instant.getTime()) / 60_000);
}

/** The instant of a local date and time in a time zone (DST-safe for whole-hour shifts). */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMinutes(timeZone, new Date(guess)) * 60_000;
  return new Date(guess - offsetMinutes(timeZone, new Date(first)) * 60_000);
}

function localDate(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const addDays = (date: string, n: number) => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export interface SlotRules {
  timeZone: string;
  /** Local "HH:MM"; an end at or before the start runs past midnight. */
  openFrom: string;
  openTo: string;
  slotMinutes: number;
  /** A slot must be at least this far from now (preparation time). */
  leadMinutes: number;
  /** 0 = today only. */
  daysAhead: number;
}

/**
 * The pick-up times a guest may choose: every slot within the opening hours
 * of today (and the next days), at least the lead time from now. The last
 * slot is the closing time.
 */
export function pickupSlots(now: Date, r: SlotRules): Date[] {
  const earliest = now.getTime() + r.leadMinutes * 60_000;
  const from = minutesOf(r.openFrom);
  let to = minutesOf(r.openTo);
  if (to <= from) to += 24 * 60;
  const out: Date[] = [];
  const today = localDate(r.timeZone, now);
  // Yesterday's window may still be open past midnight.
  for (let day = -1; day <= r.daysAhead; day++) {
    const date = addDays(today, day);
    for (let m = from; m <= to; m += r.slotMinutes) {
      const at = zonedInstant(
        addDays(date, Math.floor(m / (24 * 60))),
        hhmm(m % (24 * 60)),
        r.timeZone,
      );
      if (at.getTime() >= earliest) out.push(at);
    }
  }
  return [...new Map(out.map((d) => [d.getTime(), d])).values()].sort(
    (a, b) => a.getTime() - b.getTime(),
  );
}

/** Whether a chosen time is one of the offered slots (a slot just passed is still taken). */
export function isPickupSlot(chosen: Date, now: Date, r: SlotRules, graceMinutes = 5): boolean {
  const offered = pickupSlots(new Date(now.getTime() - graceMinutes * 60_000), r);
  return offered.some((d) => d.getTime() === chosen.getTime());
}

/** When an accepted order for later goes to the kitchen: its lead time before pick-up. */
export const releaseAt = (pickupAt: Date, leadMinutes: number) =>
  new Date(pickupAt.getTime() - leadMinutes * 60_000);

export type GuestState =
  "AWAITING_PAYMENT" | "RECEIVED" | "SCHEDULED" | "PREPARING" | "READY" | "COLLECTED" | "CANCELLED";

/**
 * Where a guest order stands. Payment and fulfilment are separate: an order
 * paid online is still prepared, made ready and handed over; one paid at the
 * counter is handed over when it is paid.
 */
export function guestState(t: {
  status: "OPEN" | "CLOSED" | "CANCELLED" | "MERGED";
  payOnline: boolean;
  paid: boolean;
  acceptedAt: Date | null;
  readyAt: Date | null;
  pickedUpAt: Date | null;
  /** Items not yet sent to the kitchen (held for a later pick-up). */
  pendingLines: number;
  sentLines: number;
  /** Every sent item bumped on its kitchen screen. */
  kitchenReady: boolean;
}): GuestState {
  if (t.status === "CANCELLED" || t.status === "MERGED") return "CANCELLED";
  if (t.pickedUpAt) return "COLLECTED";
  if (!t.payOnline && t.status === "CLOSED") return "COLLECTED";
  if (t.payOnline && !t.paid) return "AWAITING_PAYMENT";
  if (!t.acceptedAt) return "RECEIVED";
  if (t.readyAt) return "READY";
  if (t.pendingLines > 0) return "SCHEDULED";
  if (t.sentLines > 0 && t.kitchenReady) return "READY";
  return "PREPARING";
}

/** Unpaid online orders are cancelled after this long (the payment page expires too). */
export const ONLINE_PAYMENT_MINUTES = 30;
