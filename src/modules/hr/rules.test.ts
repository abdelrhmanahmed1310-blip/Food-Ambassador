import { describe, expect, it } from "vitest";
import { createsReportingLoop, documentState, orgTree } from "./rules";

describe("HR rules (ADR-079)", () => {
  it("classifies documents by expiry: valid on the expiry day, flagged 30 days ahead", () => {
    expect(documentState(null, "2026-11-02")).toBe("NO_EXPIRY");
    expect(documentState("2026-11-01", "2026-11-02")).toBe("EXPIRED");
    expect(documentState("2026-11-02", "2026-11-02")).toBe("EXPIRING");
    expect(documentState("2026-12-02", "2026-11-02")).toBe("EXPIRING");
    expect(documentState("2026-12-03", "2026-11-02")).toBe("VALID");
  });

  it("refuses a manager who reports, directly or not, to the employee", () => {
    const managerOf = new Map<string, string | null>([
      ["ceo", null],
      ["ops", "ceo"],
      ["chef", "ops"],
    ]);
    expect(createsReportingLoop("ops", "chef", managerOf)).toBe(true);
    expect(createsReportingLoop("ceo", "chef", managerOf)).toBe(true);
    expect(createsReportingLoop("chef", "chef", managerOf)).toBe(true);
    expect(createsReportingLoop("chef", "ceo", managerOf)).toBe(false);
    expect(createsReportingLoop("new", null, managerOf)).toBe(false);
  });

  it("builds the reporting tree; people whose manager is out of view become roots", () => {
    const people = [
      { id: "ceo", managerId: null, name: "Amal" },
      { id: "chef", managerId: "ops", name: "Omar" },
      { id: "ops", managerId: "ceo", name: "Huda" },
      { id: "cook", managerId: "chef", name: "Ali" },
      { id: "far", managerId: "elsewhere", name: "Badr" },
    ];
    const tree = orgTree(people, (p) => p.name);
    expect(tree.map((n) => n.person.id)).toEqual(["ceo", "far"]);
    expect(tree[0].reports[0].person.id).toBe("ops");
    expect(tree[0].reports[0].reports[0].reports[0].person.id).toBe("cook");
  });
});
