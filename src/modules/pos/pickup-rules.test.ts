import { describe, expect, it } from "vitest";
import { guestState, isPickupSlot, pickupSlots, releaseAt, zonedInstant } from "./pickup-rules";

const riyadh = { timeZone: "Asia/Riyadh", slotMinutes: 15, leadMinutes: 20, daysAhead: 0 };
const local = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);

describe("pick-up slots (ADR-071)", () => {
  it("converts local times in the branch's time zone", () => {
    expect(zonedInstant("2026-11-02", "18:30", "Asia/Riyadh").toISOString()).toBe(
      "2026-11-02T15:30:00.000Z",
    );
    // Across a daylight-saving change (Cairo, last Friday of October).
    expect(zonedInstant("2026-07-01", "12:00", "Africa/Cairo").toISOString()).toBe(
      "2026-07-01T09:00:00.000Z",
    );
    expect(zonedInstant("2026-12-01", "12:00", "Africa/Cairo").toISOString()).toBe(
      "2026-12-01T10:00:00.000Z",
    );
  });

  it("offers slots in opening hours at least the lead time ahead", () => {
    // 17:52 in Riyadh: the first slot is 18:15 (17:52 + 20 min = 18:12).
    const now = new Date("2026-11-02T14:52:00Z");
    const slots = pickupSlots(now, { ...riyadh, openFrom: "12:00", openTo: "19:00" });
    expect(slots.map(local)).toEqual(["18:15", "18:30", "18:45", "19:00"]);
    expect(pickupSlots(now, { ...riyadh, openFrom: "09:00", openTo: "12:00" })).toEqual([]);
    expect(
      pickupSlots(now, { ...riyadh, openFrom: "09:00", openTo: "12:00", daysAhead: 1 }).map(
        local,
      )[0],
    ).toBe("09:00");
  });

  it("handles opening hours past midnight", () => {
    // 00:30 in Riyadh, open 18:00–02:00: yesterday's window is still open.
    const now = new Date("2026-11-02T21:30:00Z");
    const slots = pickupSlots(now, {
      ...riyadh,
      openFrom: "18:00",
      openTo: "02:00",
      slotMinutes: 30,
    });
    expect(slots.map(local).slice(0, 3)).toEqual(["01:00", "01:30", "02:00"]);
  });

  it("accepts only offered slots, with a few minutes' grace", () => {
    const rules = { ...riyadh, openFrom: "12:00", openTo: "23:00" };
    const now = new Date("2026-11-02T14:52:00Z");
    expect(isPickupSlot(new Date("2026-11-02T15:15:00Z"), now, rules)).toBe(true);
    expect(isPickupSlot(new Date("2026-11-02T15:20:00Z"), now, rules)).toBe(false); // not on a slot
    expect(isPickupSlot(new Date("2026-11-02T15:00:00Z"), now, rules)).toBe(false); // too soon
    expect(
      isPickupSlot(new Date("2026-11-02T15:15:00Z"), new Date("2026-11-02T14:57:00Z"), rules),
    ).toBe(true);
    expect(releaseAt(new Date("2026-11-02T15:15:00Z"), 20).toISOString()).toBe(
      "2026-11-02T14:55:00.000Z",
    );
  });
});

describe("guest order state", () => {
  const base = {
    status: "OPEN" as const,
    payOnline: false,
    paid: false,
    acceptedAt: null,
    readyAt: null,
    pickedUpAt: null,
    pendingLines: 2,
    sentLines: 0,
    kitchenReady: false,
  };
  const at = new Date();
  it("follows payment, acceptance, the kitchen or staff, and hand-over", () => {
    expect(guestState(base)).toBe("RECEIVED");
    expect(guestState({ ...base, payOnline: true })).toBe("AWAITING_PAYMENT");
    expect(guestState({ ...base, payOnline: true, paid: true, status: "CLOSED" })).toBe("RECEIVED");
    expect(guestState({ ...base, acceptedAt: at })).toBe("SCHEDULED");
    const sent = { ...base, acceptedAt: at, pendingLines: 0, sentLines: 2 };
    expect(guestState(sent)).toBe("PREPARING");
    expect(guestState({ ...sent, kitchenReady: true })).toBe("READY");
    expect(guestState({ ...sent, readyAt: at })).toBe("READY"); // no kitchen screens
    expect(guestState({ ...sent, status: "CLOSED" })).toBe("COLLECTED"); // paid at the counter
    expect(guestState({ ...sent, payOnline: true, paid: true, status: "CLOSED" })).toBe(
      "PREPARING",
    );
    expect(
      guestState({ ...sent, payOnline: true, paid: true, status: "CLOSED", pickedUpAt: at }),
    ).toBe("COLLECTED");
    expect(guestState({ ...base, status: "CANCELLED" })).toBe("CANCELLED");
  });
});
