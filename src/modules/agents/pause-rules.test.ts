import { describe, expect, it } from "vitest";
import { pausedUntil } from "./pause-rules";

/** Rejection reasons pause repeat proposals (ADR-155). */

const d = (s: string) => new Date(`${s}T10:00:00Z`);
const r = (day: string, reason: string | null = "NOT_NEEDED", lifted: string | null = null) => ({
  reason,
  decidedAt: d(day),
  pauseLiftedAt: lifted ? d(lifted) : null,
});

describe("pause after rejections", () => {
  it("pauses 30 days from the second qualifying rejection within 30 days", () => {
    const two = [r("2026-11-01"), r("2026-11-20", "ALREADY_DONE")];
    expect(pausedUntil(two, d("2026-11-25"))).toEqual(d("2026-12-20"));
    expect(pausedUntil(two, d("2026-12-21"))).toBeNull();
  });

  it("needs two, close enough, with a pausing reason, not lifted", () => {
    expect(pausedUntil([r("2026-11-20")], d("2026-11-25"))).toBeNull();
    expect(pausedUntil([r("2026-10-01"), r("2026-11-20")], d("2026-11-25"))).toBeNull();
    expect(
      pausedUntil([r("2026-11-10", "WRONG_AMOUNT"), r("2026-11-20")], d("2026-11-25")),
    ).toBeNull();
    expect(pausedUntil([r("2026-11-10", null), r("2026-11-20")], d("2026-11-25"))).toBeNull();
    expect(
      pausedUntil([r("2026-11-10", "NOT_NEEDED", "2026-11-21"), r("2026-11-20")], d("2026-11-25")),
    ).toBeNull();
  });
});
