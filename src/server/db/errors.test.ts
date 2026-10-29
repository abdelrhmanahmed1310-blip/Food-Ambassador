import { describe, expect, it } from "vitest";
import { isUniqueViolation, violatedConstraint } from "./errors";

const adapterError = (index: string) => ({
  code: "P2002",
  meta: {
    driverAdapterError: {
      cause: { kind: "UniqueConstraintViolation", originalCode: "23505", constraint: { index } },
    },
  },
});

describe("isUniqueViolation", () => {
  it("matches driver-adapter unique violations by constraint suffix", () => {
    const e = adapterError("branches_organization_id_code_key");
    expect(violatedConstraint(e)).toBe("branches_organization_id_code_key");
    expect(isUniqueViolation(e)).toBe(true);
    expect(isUniqueViolation(e, "_code_key")).toBe(true);
    expect(isUniqueViolation(e, "organizations_slug_key")).toBe(false);
  });

  it("does not match on unrelated payload keys", () => {
    // The payload always contains "code" keys; only the constraint name counts.
    expect(isUniqueViolation(adapterError("users_email_key"), "_code_key")).toBe(false);
  });

  it("supports classic meta.target arrays", () => {
    expect(
      isUniqueViolation({ code: "P2002", meta: { target: ["organization_id", "code"] } }, "code"),
    ).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
