import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { approvalBlock, chainFor, holdsApprovalLevel, nextApprovalLevel } from "./rules";

const d = (v: string) => new Decimal(v);
const layers = [
  { position: 4, aboveAmount: d("20000") },
  { position: 1, aboveAmount: d("0") },
  { position: 2, aboveAmount: d("5000") },
];

describe("approval matrix (ADR-049)", () => {
  it("requires each layer only above its own limit, branch layers first", () => {
    expect(chainFor(layers, d("100"))).toEqual(["BRANCH"]);
    expect(chainFor(layers, d("5000"))).toEqual(["BRANCH"]); // at the limit: not required
    expect(chainFor(layers, d("5000.01"))).toEqual(["BRANCH", "BRANCH"]);
    expect(chainFor(layers, d("25000"))).toEqual(["BRANCH", "BRANCH", "HEAD_OFFICE"]);
    expect(chainFor(layers, d("0"))).toEqual([]); // nothing to approve
    expect(chainFor([], d("1000000"))).toEqual([]);
    expect(chainFor([{ position: 4, aboveAmount: d("0") }], d("1"))).toEqual(["HEAD_OFFICE"]);
    const chain = chainFor(layers, d("25000"));
    expect([0, 1, 2, 3].map((g) => nextApprovalLevel(chain, g))).toEqual([
      "BRANCH",
      "BRANCH",
      "HEAD_OFFICE",
      null,
    ]);
  });

  it("branch steps need a grant on the document's own site; head office an organization-wide one", () => {
    const site = { branchId: "b1", warehouseId: "w1" };
    const p = "purchasing.approve";
    const g = (
      scope: Parameters<typeof holdsApprovalLevel>[0][number]["scope"],
      permission = p,
    ) => [{ permission, scope }];
    const org = g({ type: "ORGANIZATION" });
    const branch = g({ type: "BRANCH", branchId: "b1" });
    const warehouse = g({ type: "WAREHOUSE", warehouseId: "w1" });
    const otherBranch = g({ type: "BRANCH", branchId: "b2" });
    expect(holdsApprovalLevel(branch, p, "BRANCH", site)).toBe(true);
    expect(holdsApprovalLevel(warehouse, p, "BRANCH", site)).toBe(true);
    expect(holdsApprovalLevel(org, p, "BRANCH", site)).toBe(false);
    expect(holdsApprovalLevel(otherBranch, p, "BRANCH", site)).toBe(false);
    expect(holdsApprovalLevel(org, p, "HEAD_OFFICE", site)).toBe(true);
    expect(holdsApprovalLevel(branch, p, "HEAD_OFFICE", site)).toBe(false);
    expect(holdsApprovalLevel(org, p, "ANY", site)).toBe(true);
    expect(holdsApprovalLevel(otherBranch, p, "ANY", site)).toBe(false);
    // The permission must match the document type.
    expect(
      holdsApprovalLevel(g({ type: "ORGANIZATION" }, "inventory.count.approve"), p, "ANY", site),
    ).toBe(false);
  });

  it("explains why someone cannot sign", () => {
    const base = { authors: ["u1", null], signedThisRound: ["u2"], holdsLevel: true };
    expect(approvalBlock({ ...base, userId: "u1" })).toBe("SELF");
    expect(approvalBlock({ ...base, userId: "u2" })).toBe("ALREADY_SIGNED");
    expect(approvalBlock({ ...base, userId: "u3", holdsLevel: false })).toBe("LEVEL");
    expect(approvalBlock({ ...base, userId: "u3" })).toBeNull();
  });
});
