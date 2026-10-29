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
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_000_001);
    expect(earlier < later).toBe(true);
    expect(earlier.slice(0, 13).replace("-", "")).toBe(
      (1_700_000_000_000).toString(16).padStart(12, "0"),
    );
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
