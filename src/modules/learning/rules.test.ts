import { describe, expect, it } from "vitest";
import { complianceStatus, expiryFor, latestRecord, requirementApplies } from "./rules";

describe("expiryFor", () => {
  it("adds months, keeping to the month's last day", () => {
    expect(expiryFor("2026-01-31", 1)).toBe("2026-02-28");
    expect(expiryFor("2028-01-31", 1)).toBe("2028-02-29");
    expect(expiryFor("2026-03-15", 12)).toBe("2027-03-15");
    expect(expiryFor("2026-03-15", 24)).toBe("2028-03-15");
    expect(expiryFor("2026-03-15", null)).toBeNull();
  });
});

describe("requirementApplies", () => {
  const cook = { jobTitle: " Line Cook ", departmentId: "d1", branchId: "b1" };
  it("matches everyone, a job title, a department or a branch", () => {
    const r = { jobTitle: null, departmentId: null, branchId: null };
    expect(requirementApplies({ ...r, scope: "ALL" }, cook)).toBe(true);
    expect(requirementApplies({ ...r, scope: "JOB_TITLE", jobTitle: "line cook" }, cook)).toBe(
      true,
    );
    expect(requirementApplies({ ...r, scope: "JOB_TITLE", jobTitle: "Cashier" }, cook)).toBe(false);
    expect(requirementApplies({ ...r, scope: "DEPARTMENT", departmentId: "d1" }, cook)).toBe(true);
    expect(requirementApplies({ ...r, scope: "BRANCH", branchId: "b2" }, cook)).toBe(false);
  });
});

describe("complianceStatus", () => {
  const base = { today: "2026-11-05", hireDate: "2026-10-01", dueWithinDays: 30 };
  it("is due until the deadline after hire, then overdue", () => {
    expect(complianceStatus({ ...base, latest: null })).toEqual({
      status: "OVERDUE",
      dueOn: "2026-10-31",
      expiresOn: null,
    });
    expect(complianceStatus({ ...base, dueWithinDays: 60, latest: null }).status).toBe("DUE");
  });

  it("is compliant, expiring within 30 days, or expired after its expiry day", () => {
    const at = (expiresOn: string | null) =>
      complianceStatus({ ...base, latest: { completedOn: "2025-12-01", expiresOn } }).status;
    expect(at(null)).toBe("COMPLIANT");
    expect(at("2027-06-01")).toBe("COMPLIANT");
    expect(at("2026-12-05")).toBe("EXPIRING");
    expect(at("2026-11-05")).toBe("EXPIRING"); // still valid today
    expect(at("2026-11-04")).toBe("EXPIRED");
  });
});

describe("latestRecord", () => {
  it("counts the record that runs longest", () => {
    const a = { completedOn: "2025-01-01", expiresOn: "2026-01-01" };
    const b = { completedOn: "2026-01-01", expiresOn: "2027-01-01" };
    const c = { completedOn: "2024-01-01", expiresOn: null };
    expect(latestRecord([a, b])).toBe(b);
    expect(latestRecord([a, c, b])).toBe(c);
    expect(latestRecord([])).toBeNull();
  });
});
