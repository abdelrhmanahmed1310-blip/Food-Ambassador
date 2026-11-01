import { describe, expect, it } from "vitest";
import { ADAPTERS, parseDeliveryBody, unmappedIds } from "./adapters";

const placed = {
  event: "order.placed",
  order: {
    id: "HS-1001",
    placedAt: "2026-11-01T12:00:00+03:00",
    items: [
      { externalId: "BRG", quantity: 2, unitPrice: "25", modifiers: [{ externalId: "CHS" }] },
    ],
    total: "50",
  },
};

describe("delivery adapters (ADR-069)", () => {
  it("reads the canonical format for every platform", () => {
    for (const p of ["HUNGERSTATION", "JAHEZ", "KEETA", "OTHER"] as const) {
      const r = parseDeliveryBody(p, JSON.stringify(placed));
      expect(r.ok).toBe(true);
      if (r.ok && r.event.event === "order.placed") {
        expect(r.event.order.discount).toBe("0");
        expect(r.event.order.items[0].modifiers[0].quantity).toBe(1);
      }
    }
    expect(parseDeliveryBody("OTHER", "{not json").ok).toBe(false);
    expect(parseDeliveryBody("OTHER", JSON.stringify({ event: "order.placed" })).ok).toBe(false);
    expect(
      parseDeliveryBody("OTHER", JSON.stringify({ event: "order.cancelled", order: { id: "X" } }))
        .ok,
    ).toBe(true);
  });

  it("claims no native integration that was not tested against the platform", () => {
    expect(Object.values(ADAPTERS).every((a) => !a.native)).toBe(true);
  });

  it("lists the items and modifiers still to map", () => {
    const order = {
      items: [
        { externalId: "BRG", modifiers: [{ externalId: "CHS" }] },
        { externalId: "COLA", modifiers: [] },
      ],
    };
    expect(unmappedIds(order, { items: new Set(["BRG"]), options: new Set() })).toEqual({
      items: ["COLA"],
      options: ["CHS"],
    });
  });
});
