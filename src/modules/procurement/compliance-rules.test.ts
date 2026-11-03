import { describe, expect, it } from "vitest";
import {
  accountNumberValid,
  groupedAccount,
  ibanProblem,
  lastFour,
  maskedAccount,
  supplierOrderBlock,
  swiftValid,
} from "./compliance-rules";

describe("supplierOrderBlock", () => {
  it("lets a pending supplier be drafted for but not sent to", () => {
    const base = { status: "PENDING_APPROVAL" as const, expiredRequiredDocuments: 0 };
    expect(supplierOrderBlock({ ...base, step: "draft" })).toBeNull();
    expect(supplierOrderBlock({ ...base, step: "send" })).toBe("SUPPLIER_NOT_APPROVED");
  });

  it("refuses a blocked supplier at every step", () => {
    for (const step of ["draft", "send"] as const)
      expect(supplierOrderBlock({ status: "BLOCKED", expiredRequiredDocuments: 0, step })).toBe(
        "SUPPLIER_BLOCKED",
      );
  });

  it("refuses sending while a required document is expired", () => {
    expect(
      supplierOrderBlock({ status: "APPROVED", expiredRequiredDocuments: 1, step: "send" }),
    ).toBe("SUPPLIER_DOCUMENT_EXPIRED");
    expect(
      supplierOrderBlock({ status: "APPROVED", expiredRequiredDocuments: 1, step: "draft" }),
    ).toBeNull();
    expect(
      supplierOrderBlock({ status: "APPROVED", expiredRequiredDocuments: 0, step: "send" }),
    ).toBeNull();
  });
});

describe("ibanProblem", () => {
  it("accepts valid IBANs (published examples)", () => {
    expect(ibanProblem("SA03 8000 0000 6080 1016 7519")).toBeNull();
    expect(ibanProblem("AE07 0331 2345 6789 0123 456")).toBeNull();
    expect(ibanProblem("EG380019000500000000263180002")).toBeNull();
    expect(ibanProblem("GB82 WEST 1234 5698 7654 32")).toBeNull();
    expect(ibanProblem("gb82-west-1234-5698-7654-32")).toBeNull();
  });

  it("names what is wrong", () => {
    expect(ibanProblem("SA04 8000 0000 6080 1016 7519")).toBe("checksum");
    expect(ibanProblem("SA03 8000 0000 6080 1016 751")).toBe("length");
    expect(ibanProblem("12345")).toBe("format");
    expect(ibanProblem("")).toBe("format");
  });
});

describe("account helpers", () => {
  it("checks local account numbers and SWIFT codes", () => {
    expect(accountNumberValid("0123 4567 89")).toBe(true);
    expect(accountNumberValid("12")).toBe(false);
    expect(accountNumberValid("12#45")).toBe(false);
    expect(swiftValid("NCBKSAJE")).toBe(true);
    expect(swiftValid("ncbksajexxx")).toBe(true);
    expect(swiftValid("NCBK1AJE")).toBe(false);
    expect(swiftValid("NCBKSAJEX")).toBe(false);
  });

  it("masks and groups", () => {
    expect(lastFour("SA03 8000 0000 6080 1016 7519")).toBe("7519");
    expect(maskedAccount("7519")).toBe("•••• 7519");
    expect(groupedAccount("sa0380000000608010167519")).toBe("SA03 8000 0000 6080 1016 7519");
  });
});
