import { describe, expect, it } from "vitest";
import {
  applicable,
  blocksClearance,
  checklist,
  expiryState,
  type Requirement,
} from "./document-rules";

const req = (r: Partial<Requirement> & { id: string; documentTypeId: string }): Requirement => ({
  scope: "SHIPMENT",
  destinationCountry: null,
  originCountry: null,
  hsPrefix: null,
  ...r,
});

const facts = {
  destination: "SA",
  origin: "NZ",
  products: [
    { id: "milk", hsCode: "04022110", originCountry: null },
    { id: "beef", hsCode: "02023000", originCountry: "AU" },
    { id: "tea", hsCode: null, originCountry: null },
  ],
};

describe("trade document rules (ADR-114)", () => {
  it("flags expiry 30 days ahead; expiring today is still valid", () => {
    expect(expiryState(null, "2026-11-04")).toBe("NO_EXPIRY");
    expect(expiryState("2026-11-04", "2026-11-04")).toBe("EXPIRING");
    expect(expiryState("2026-11-03", "2026-11-04")).toBe("EXPIRED");
    expect(expiryState("2026-12-04", "2026-11-04")).toBe("EXPIRING");
    expect(expiryState("2026-12-05", "2026-11-04")).toBe("VALID");
  });

  it("matches requirements by destination, origin and HS prefix; unknowns never match", () => {
    const a = applicable(
      [
        req({ id: "invoice", documentTypeId: "INV" }),
        req({ id: "dairy", documentTypeId: "HEALTH", hsPrefix: "04" }),
        req({
          id: "meat-au",
          documentTypeId: "HALAL",
          scope: "PRODUCT",
          hsPrefix: "02",
          originCountry: "AU",
        }),
        req({ id: "egypt-only", documentTypeId: "X", destinationCountry: "EG" }),
        req({ id: "from-china", documentTypeId: "Y", originCountry: "CN" }),
        req({ id: "registration", documentTypeId: "REG", scope: "PRODUCT" }),
      ],
      facts,
    );
    expect(a.map((x) => [x.requirement.id, x.productIds])).toEqual([
      ["invoice", ["milk", "beef", "tea"]],
      ["dairy", ["milk"]],
      ["meat-au", ["beef"]],
      ["registration", ["milk", "beef", "tea"]],
    ]);
  });

  it("checks each line against the best document held, and what blocks clearance", () => {
    const applied = applicable(
      [
        req({ id: "invoice", documentTypeId: "INV" }),
        req({ id: "invoice-again", documentTypeId: "INV", destinationCountry: "SA" }),
        req({ id: "reg", documentTypeId: "REG", scope: "PRODUCT", hsPrefix: "0" }),
      ],
      facts,
    );
    const lines = checklist(
      applied,
      [
        { id: "d1", documentTypeId: "INV", shipmentId: "S1", productId: null, expiresOn: null },
        {
          id: "old",
          documentTypeId: "REG",
          shipmentId: null,
          productId: "milk",
          expiresOn: "2026-01-01",
        },
        {
          id: "new",
          documentTypeId: "REG",
          shipmentId: null,
          productId: "milk",
          expiresOn: "2026-11-20",
        },
        {
          id: "gone",
          documentTypeId: "REG",
          shipmentId: null,
          productId: "beef",
          expiresOn: "2026-10-01",
        },
        { id: "other", documentTypeId: "INV", shipmentId: "S2", productId: null, expiresOn: null },
      ],
      "S1",
      "2026-11-04",
    );
    expect(lines.map((l) => [l.documentTypeId, l.productId, l.documentId, l.state])).toEqual([
      ["INV", null, "d1", "OK"],
      ["REG", "milk", "new", "EXPIRING"],
      ["REG", "beef", "gone", "EXPIRED"],
    ]);
    expect(blocksClearance(lines)).toBe(true);
    expect(blocksClearance(lines.filter((l) => l.productId !== "beef"))).toBe(false);
  });
});
