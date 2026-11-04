import { describe, expect, it } from "vitest";
import { render, smsParts, unknownPlaceholders, withUnsubscribe } from "./campaign-rules";

describe("campaign messages (ADR-119)", () => {
  it("counts SMS parts by GSM-7 and UCS-2 rules", () => {
    expect(smsParts("a".repeat(160))).toEqual({ encoding: "GSM-7", length: 160, parts: 1 });
    expect(smsParts("a".repeat(161)).parts).toBe(2);
    expect(smsParts("a".repeat(306)).parts).toBe(2);
    expect(smsParts("a".repeat(307)).parts).toBe(3);
    // Extension characters take two places.
    expect(smsParts("€".repeat(80))).toEqual({ encoding: "GSM-7", length: 160, parts: 1 });
    // Arabic is UCS-2: 70 in one message, 67 per part after.
    expect(smsParts("م".repeat(70))).toEqual({ encoding: "UCS-2", length: 70, parts: 1 });
    expect(smsParts("م".repeat(71)).parts).toBe(2);
    expect(smsParts("م".repeat(135)).parts).toBe(3);
  });

  it("fills in the first name and rejects unknown placeholders", () => {
    expect(render("Hi {name}, 20% off this week", { name: "Sara Al Harbi" })).toBe(
      "Hi Sara, 20% off this week",
    );
    expect(render("Hi {name}, welcome back", { name: null })).toBe("Hi , welcome back");
    expect(unknownPlaceholders("Hi {name} {phone} {code}")).toEqual(["{phone}", "{code}"]);
    expect(withUnsubscribe("SMS", "Hi", "https://x/u/1", "Stop:")).toBe("Hi\nStop: https://x/u/1");
  });
});
