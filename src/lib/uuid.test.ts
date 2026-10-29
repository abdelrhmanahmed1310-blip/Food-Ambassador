import { describe, expect, it } from "vitest";
import { isUuid, uuidv7 } from "./uuid";

describe("uuidv7", () => {
  it("produces valid version-7 UUIDs", () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("encodes the timestamp so IDs sort by creation time", () => {
    // Far-future timestamps, so the never-backwards rule does not clamp them.
    const t = 4_000_000_000_000;
    const earlier = uuidv7(t);
    const later = uuidv7(t + 1);
    expect(earlier < later).toBe(true);
    expect(earlier.slice(0, 13).replace("-", "")).toBe(t.toString(16).padStart(12, "0"));
  });

  it("is strictly increasing within the same millisecond", () => {
    const fixed = 4_100_000_000_000;
    const ids = Array.from({ length: 5000 }, () => uuidv7(fixed));
    for (let i = 1; i < ids.length; i++)
      expect(ids[i - 1] < ids[i], `${ids[i - 1]} < ${ids[i]}`).toBe(true);
    expect(ids.every(isUuid)).toBe(true);
  });

  it("never goes backwards when the clock does", () => {
    const a = uuidv7(4_200_000_000_000);
    const b = uuidv7(4_199_999_999_000);
    expect(a < b).toBe(true);
  });

  it("is unique across many calls", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7()));
    expect(ids.size).toBe(5000);
  });

  it("rejects non-UUID values", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
