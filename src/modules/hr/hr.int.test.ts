import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addEmployeeDocument,
  changeEmployeeStatus,
  createDepartment,
  createEmployee,
  getEmployee,
  hrOverview,
  listEmployees,
  orgChart,
  removeEmployeeDocument,
  setDepartmentArchived,
  updateEmployee,
} from "./service";

/** HRIS (ADR-079): records, reporting line, documents, scopes and isolation. */

let ctx: TenantContext;
let other: TenantContext;
let branchManager: TenantContext;
let cashier: TenantContext;
let riyadh: string;
let jeddah: string;
let kitchenDept: string;

const person = (over: Record<string, string> = {}) => ({
  firstName: "Sara",
  lastName: "Ali",
  jobTitle: "Cook",
  branchId: riyadh,
  employmentType: "FULL_TIME",
  hireDate: "2026-01-15",
  ...over,
});

beforeAll(async () => {
  ({ ctx } = await createTenant("hr", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  ({ ctx: other } = await createTenant("hr-other", {
    baseCurrency: "SAR",
    timeZone: "Asia/Riyadh",
  }));
  riyadh = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  jeddah = (await createBranch(ctx, { code: "JED", name: "Jeddah", type: "RESTAURANT" })).id;
  ({ ctx: branchManager } = await addMember(ctx, "branch_manager", {
    scopeType: "BRANCH",
    branchId: riyadh,
  }));
  ({ ctx: cashier } = await addMember(ctx, "cashier"));
  kitchenDept = (await createDepartment(ctx, { code: "kit", name: "Kitchen" })).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("HRIS (ADR-079)", () => {
  let head: string;
  let chef: string;
  let cook: string;

  it("numbers employees automatically or keeps the number given; refuses duplicates", async () => {
    const h = await createEmployee(
      ctx,
      person({ firstName: "Huda", jobTitle: "Head chef", departmentId: kitchenDept }),
    );
    expect(h.number).toBe("EMP-00001");
    head = h.id;
    chef = (
      await createEmployee(ctx, person({ number: "r-77", firstName: "Omar", managerId: head }))
    ).id;
    const c = await createEmployee(
      ctx,
      person({ firstName: "Ali", managerId: chef, nationalId: "2123456789" }),
    );
    cook = c.id;
    expect(c.number).toBe("EMP-00002");
    expect((await getDb().employee.findUniqueOrThrow({ where: { id: chef } })).number).toBe("R-77");
    await expectAppError(
      createEmployee(ctx, person({ number: "R-77" })),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("refuses a reporting loop and a manager from another organization", async () => {
    await expectAppError(
      updateEmployee(
        ctx,
        head,
        person({ firstName: "Huda", jobTitle: "Head chef", managerId: cook }),
      ),
      "BUSINESS_RULE_VIOLATION",
    );
    const stranger = await createBranch(other, { code: "X", name: "X", type: "RESTAURANT" });
    const foreign = await createEmployee(other, person({ branchId: stranger.id }));
    await expectAppError(
      createEmployee(ctx, person({ managerId: foreign.id })),
      "BUSINESS_RULE_VIOLATION",
    );
    // Another organization's branch is simply not found here.
    await expectAppError(
      createEmployee(ctx, person({ branchId: stranger.id })),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("keeps ID numbers from viewers and out of the audit log", async () => {
    expect((await getEmployee(ctx, cook)).nationalId).toBe("2123456789");
    const seen = await getEmployee(branchManager, cook);
    expect(seen.nationalId).toBeNull();
    expect(seen.can.manage).toBe(false);
    const audit = await getDb().auditEvent.findMany({ where: { entityId: cook } });
    expect(JSON.stringify(audit)).not.toContain("2123456789");
  });

  it("tracks documents and their expiry; numbers only for HR managers", async () => {
    const doc = await addEmployeeDocument(ctx, cook, {
      type: "HEALTH_CERTIFICATE",
      number: "HC-555",
      issuedOn: "2025-11-01",
      expiresOn: "2000-01-01",
    }).catch((e) => e);
    expect(doc.code).toBe("VALIDATION_FAILED"); // expiry before issue
    // The organization's business date (Riyadh), as the service uses — not UTC.
    const today = businessDate(ctx.timeZone);
    await addEmployeeDocument(ctx, cook, {
      type: "HEALTH_CERTIFICATE",
      number: "HC-555",
      expiresOn: today,
    });
    await addEmployeeDocument(ctx, cook, {
      type: "IQAMA",
      number: "2123456789",
      expiresOn: "2099-01-01",
    });
    const e = await getEmployee(ctx, cook);
    expect(e.documents.map((d) => [d.type, d.state])).toEqual([
      ["HEALTH_CERTIFICATE", "EXPIRING"],
      ["IQAMA", "VALID"],
    ]);
    expect((await getEmployee(branchManager, cook)).documents.every((d) => d.number === null)).toBe(
      true,
    );
    const overview = await hrOverview(ctx);
    expect(overview.documents.map((d) => d.type)).toEqual(["HEALTH_CERTIFICATE"]);
    expect(overview.active).toBe(3);
    await expectAppError(removeEmployeeDocument(branchManager, e.documents[1].id), "FORBIDDEN");
    await removeEmployeeDocument(ctx, e.documents[1].id);
    expect((await getEmployee(ctx, cook)).documents).toHaveLength(1);
  });

  it("does not terminate someone who still manages people; rehire clears the termination", async () => {
    await expectAppError(
      changeEmployeeStatus(ctx, chef, {
        status: "TERMINATED",
        terminatedOn: "2026-10-31",
        reason: "Resigned",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      changeEmployeeStatus(ctx, cook, {
        status: "TERMINATED",
        terminatedOn: "2025-12-31",
        reason: "x",
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // before the hire date
    await changeEmployeeStatus(ctx, cook, {
      status: "TERMINATED",
      terminatedOn: "2026-10-31",
      reason: "Resigned",
    });
    expect((await listEmployees(ctx)).items.map((e) => e.firstName)).not.toContain("Ali");
    expect(
      (await listEmployees(ctx, { status: "TERMINATED" })).items.map((e) => e.firstName),
    ).toEqual(["Ali"]);
    await expectAppError(
      updateEmployee(ctx, cook, person({ firstName: "Ali" })),
      "BUSINESS_RULE_VIOLATION",
    );
    await changeEmployeeStatus(ctx, cook, { status: "ACTIVE" });
    const back = await getDb().employee.findUniqueOrThrow({ where: { id: cook } });
    expect([back.status, back.terminatedOn]).toEqual(["ACTIVE", null]);
  });

  it("builds the org chart from the reporting line", async () => {
    const tree = await orgChart(ctx);
    const huda = tree.find((n) => n.person.firstName === "Huda")!;
    expect(huda.reports[0].person.firstName).toBe("Omar");
    expect(huda.reports[0].reports[0].person.firstName).toBe("Ali");
  });

  it("scopes branch managers to their branch, and refuses people without HR access", async () => {
    await createEmployee(ctx, person({ firstName: "Jamal", branchId: jeddah }));
    const names = (await listEmployees(branchManager)).items.map((e) => e.firstName);
    expect(names).toContain("Ali");
    expect(names).not.toContain("Jamal");
    const jamal = (await listEmployees(ctx, { q: "Jamal" })).items[0].id;
    await expectAppError(getEmployee(branchManager, jamal), "NOT_FOUND");
    await expectAppError(createEmployee(branchManager, person()), "FORBIDDEN");
    await expectAppError(listEmployees(cashier), "FORBIDDEN");
  });

  it("archives a department only when nobody is in it; organizations never mix", async () => {
    await expectAppError(setDepartmentArchived(ctx, kitchenDept, true), "BUSINESS_RULE_VIOLATION");
    expect((await listEmployees(other)).items.map((e) => e.branch.code)).toEqual(["X"]);
    await expectAppError(getEmployee(other, cook), "NOT_FOUND");
    await expectAppError(changeEmployeeStatus(other, cook, { status: "ON_LEAVE" }), "NOT_FOUND");
  });
});
