import { beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addAuditFinding,
  cancelAudit,
  completeAudit,
  getAudit,
  getComplaint,
  investigateComplaint,
  listAudits,
  listComplaints,
  logComplaint,
  planAudit,
  raiseComplaintNonConformance,
  resolveComplaint,
} from "./quality";

/** Audits and customer complaints (ADR-098). */

let ctx: TenantContext; // owner
let staff: TenantContext; // branch staff who record food safety but do not manage it
let cairo: string;
let alex: string;
let chicken: string;
let today: string;

async function expectRule(promise: Promise<unknown>, rule: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    expect(`${e.code}:${e.details?.rule}`).toBe(`BUSINESS_RULE_VIOLATION:${rule}`);
    return;
  }
  throw new Error(`Expected ${rule} but the call succeeded`);
}

const nc = (id: string) => getDb().nonConformance.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  ({ ctx } = await createTenant("quality"));
  today = businessDate(ctx.timeZone);
  cairo = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  alex = (await createBranch(ctx, { code: "ALX", name: "Alex", type: "RESTAURANT" })).id;
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const wh = (
    await createWarehouse(ctx, { branchId: cairo, code: "MAIN", name: "Main", type: "MAIN" })
  ).id;
  chicken = (
    await createProduct(ctx, {
      sku: "CHK",
      nameEn: "Chicken thigh",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      lotTracking: "LOT",
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: wh,
    productId: chicken,
    lotCode: "L-77",
    quantity: "10",
    uomId: units.kg,
    unitCost: "100",
    idempotencyKey: `quality-${Date.now()}`,
  });
  staff = (await addMember(ctx, "warehouse", { scopeType: "BRANCH", branchId: cairo })).ctx;
});

describe("audits (ADR-098)", () => {
  it("records findings that open non-conformances, then completes with the auditor's result", async () => {
    const a = await planAudit(ctx, {
      branchId: cairo,
      type: "AUTHORITY",
      auditor: "Municipality health inspector",
      scope: "Kitchen hygiene and cold storage",
      plannedOn: today,
    });
    expect(a.number).toMatch(/^AUD-\d{4}-\d{6}$/);
    const observation = await addAuditFinding(ctx, a.id, {
      severity: "OBSERVATION",
      description: "Hand-wash sign faded",
    });
    expect(observation.nonConformance).toBeNull();
    const major = await addAuditFinding(ctx, a.id, {
      severity: "MAJOR",
      reference: "Cold chain 4.2",
      description: "Walk-in fridge at 9 °C during inspection",
    });
    expect((await nc(major.nonConformance!.id)).severity).toBe("HIGH");
    expect((await nc(major.nonConformance!.id)).source).toBe("AUDIT");
    await addAuditFinding(ctx, a.id, { severity: "MINOR", description: "Open bin lid" });

    await expectRule(
      completeAudit(ctx, a.id, { conductedOn: addDays(today, 1) }),
      "AUDIT_IN_FUTURE",
    );
    await expectRule(cancelAudit(ctx, a.id, { reason: "x" }), "AUDIT_HAS_FINDINGS");
    await completeAudit(ctx, a.id, {
      conductedOn: today,
      result: "Grade B",
      summary: "Two items to fix",
    });
    const view = await getAudit(ctx, a.id);
    expect(view.audit.status).toBe("COMPLETED");
    expect(view.counts.map((c) => c.count)).toEqual([0, 1, 1, 1]);
    await expectRule(
      addAuditFinding(ctx, a.id, { severity: "MINOR", description: "late" }),
      "AUDIT_CLOSED",
    );
    // The database holds the record too.
    await expect(
      getDb().auditFinding.update({ where: { id: major.id }, data: { description: "changed" } }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      getDb().audit.update({ where: { id: a.id }, data: { result: "A" } }),
    ).rejects.toThrow(/cannot change/);
  });

  it("can be cancelled while nothing was found, and lists late ones", async () => {
    const late = await planAudit(ctx, {
      branchId: cairo,
      type: "INTERNAL",
      auditor: "QA lead",
      scope: "Monthly walk-through",
      plannedOn: addDays(today, -3),
    });
    expect((await listAudits(ctx)).find((x) => x.id === late.id)!.overdue).toBe(true);
    expect((await attentionItems(ctx)).map((i) => i.key)).toContain("AUDITS_OVERDUE");
    await expectAppError(cancelAudit(ctx, late.id, { reason: "" }), "VALIDATION_FAILED");
    await cancelAudit(ctx, late.id, { reason: "Moved to next month" });
    expect((await getAudit(ctx, late.id)).audit.status).toBe("CANCELLED");
    await expectAppError(
      planAudit(staff, {
        branchId: cairo,
        type: "INTERNAL",
        auditor: "x",
        scope: "x",
        plannedOn: today,
      }),
      "FORBIDDEN",
    );
  });
});

describe("complaints (ADR-098)", () => {
  it("opens a HIGH non-conformance for food safety, traced to the lot", async () => {
    await expectRule(
      logComplaint(staff, {
        branchId: cairo,
        receivedOn: today,
        channel: "PHONE",
        category: "FOREIGN_OBJECT",
        productId: chicken,
        lotCode: "NOPE",
        description: "x",
      }),
      "LOT_NOT_FOUND",
    );
    const c = await logComplaint(staff, {
      branchId: cairo,
      receivedOn: today,
      channel: "PHONE",
      category: "FOREIGN_OBJECT",
      customerName: "A. Customer",
      customerContact: "+20 100 000 0000",
      orderReference: "POS-1234",
      productId: chicken,
      lotCode: "L-77",
      description: "Piece of plastic in the grilled chicken",
    });
    expect(c.number).toMatch(/^CMP-/);
    const n = await nc(c.nonConformance!.id);
    expect([n.severity, n.source]).toEqual(["HIGH", "COMPLAINT"]);
    expect(n.title).toContain("CHK lot L-77");
    // Contact details stay out of the audit log.
    const log = await getDb().auditEvent.findMany({
      where: { organizationId: ctx.organizationId, entityId: c.id },
    });
    expect(JSON.stringify(log)).not.toContain("+20 100");

    const view = await getComplaint(ctx, c.id);
    expect(view.lot?.lotCode).toBe("L-77");
    expect((await attentionItems(ctx)).map((i) => i.key)).toContain("COMPLAINTS_OPEN");
    // Branch staff log; managers investigate and resolve.
    await expectAppError(resolveComplaint(staff, c.id, { resolution: "x" }), "FORBIDDEN");
    await investigateComplaint(ctx, c.id, {
      investigation: "Packaging film from the marinade tub",
    });
    await expectAppError(resolveComplaint(ctx, c.id, { resolution: "" }), "VALIDATION_FAILED");
    await resolveComplaint(ctx, c.id, {
      resolution: "Tubs changed to lidded containers; staff briefed",
      customerResponse: "Apology and refund",
    });
    expect((await getComplaint(ctx, c.id)).complaint.status).toBe("RESOLVED");
    await expectRule(investigateComplaint(ctx, c.id, { investigation: "x" }), "COMPLAINT_RESOLVED");
    expect((await listComplaints(ctx, { open: true })).map((x) => x.id)).not.toContain(c.id);
  });

  it("raises a non-conformance on request for other complaints, and keeps branches apart", async () => {
    const c = await logComplaint(ctx, {
      branchId: cairo,
      receivedOn: today,
      channel: "ONLINE",
      category: "HYGIENE",
      description: "Dirty table",
    });
    expect(c.nonConformance).toBeNull();
    const raised = await raiseComplaintNonConformance(ctx, c.id);
    expect((await nc(raised.id)).severity).toBe("MEDIUM");
    await expectRule(raiseComplaintNonConformance(ctx, c.id), "COMPLAINT_HAS_NC");
    await expectRule(
      logComplaint(ctx, {
        branchId: cairo,
        receivedOn: addDays(today, 1),
        channel: "PHONE",
        category: "SERVICE",
        description: "x",
      }),
      "COMPLAINT_IN_FUTURE",
    );
    // A food safety complaint without its non-conformance is refused by the database.
    await expect(
      getDb().complaint.create({
        data: {
          organizationId: ctx.organizationId,
          number: "CMP-X",
          branchId: cairo,
          receivedAt: new Date(),
          channel: "PHONE",
          category: "ILLNESS",
          description: "x",
          recordedByUserId: ctx.userId,
        },
      }),
    ).rejects.toThrow();
    const elsewhere = await logComplaint(ctx, {
      branchId: alex,
      receivedOn: today,
      channel: "EMAIL",
      category: "SERVICE",
      description: "Slow service",
    });
    await expectAppError(getComplaint(staff, elsewhere.id), "NOT_FOUND");
    await expectAppError(
      logComplaint(staff, {
        branchId: alex,
        receivedOn: today,
        channel: "EMAIL",
        category: "SERVICE",
        description: "x",
      }),
      "NOT_FOUND",
    );
    const { ctx: other } = await createTenant("quality-other");
    await expectAppError(getComplaint(other, c.id), "NOT_FOUND");
  });
});
