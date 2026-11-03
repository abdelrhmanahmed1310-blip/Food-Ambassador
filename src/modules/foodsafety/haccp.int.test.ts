import { beforeAll, describe, expect, it } from "vitest";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addHaccpHazard,
  addHaccpStep,
  approveHaccpPlan,
  createHaccpPlan,
  getHaccpPlan,
  linkHaccpCheckpoint,
  listHaccpPlans,
  newHaccpPlanVersion,
  saveHaccpControlPoint,
} from "./haccp";
import { addRecord, createCheckpoint } from "./service";

/** HACCP plans linked to monitoring and corrective action (ADR-096). */

let ctx: TenantContext; // owner: approves
let qa: TenantContext; // food safety: writes the plan
let branchId: string;
let cooker: string; // min 75 °C
let fridge: string; // 0–8 °C: too wide for a 5 °C limit
let coldRoom: string; // 0–4 °C

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

const future = () => addDays(businessDate(ctx.timeZone), 365);

beforeAll(async () => {
  ({ ctx } = await createTenant("haccp"));
  qa = (await addMember(ctx, "food_safety")).ctx;
  branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  const cp = (code: string, kind: string, min?: string, max?: string) =>
    createCheckpoint(ctx, { branchId, code, name: code, kind, minCelsius: min, maxCelsius: max });
  cooker = (await cp("COOK", "COOKING", "75")).id;
  fridge = (await cp("FR8", "FRIDGE", "0", "8")).id;
  coldRoom = (await cp("FR4", "FRIDGE", "0", "4")).id;
});

describe("HACCP plan (ADR-096)", () => {
  it("is built step by step, classified with the decision tree, and approved by someone else", async () => {
    const plan = await createHaccpPlan(qa, {
      code: "chk",
      name: "Grilled chicken",
      scope: "Marinated chicken thighs, grilled and served hot",
      intendedUse: "Eaten on the premises, general public",
      team: "Head chef, QA lead",
    });
    expect(plan.code).toBe("CHK");
    await expectAppError(createHaccpPlan(qa, { code: "CHK", name: "x", scope: "x" }), "CONFLICT");
    await expectRule(
      approveHaccpPlan(ctx, plan.id, { reviewDueOn: future() }),
      "HACCP_PLAN_INCOMPLETE",
    );

    const receiving = await addHaccpStep(qa, plan.id, { name: "Receiving" });
    const storage = await addHaccpStep(qa, plan.id, { name: "Cold storage" });
    const cooking = await addHaccpStep(qa, plan.id, { name: "Grilling" });

    // Not significant → PRP; calling it a CCP needs a reason.
    await expectRule(
      addHaccpHazard(qa, plan.id, {
        stepId: receiving.id,
        type: "PHYSICAL",
        description: "Packaging fragments",
        likelihood: "1",
        severity: "2",
        classification: "CCP",
      }),
      "CLASSIFICATION_JUSTIFICATION_REQUIRED",
    );
    const prp = await addHaccpHazard(qa, plan.id, {
      stepId: receiving.id,
      type: "PHYSICAL",
      description: "Packaging fragments",
      likelihood: "1",
      severity: "2",
    });
    expect(prp.classification).toBe("PRP");
    // Q1 yes, Q2 yes → CCP.
    const kill = await addHaccpHazard(qa, plan.id, {
      stepId: cooking.id,
      type: "BIOLOGICAL",
      description: "Salmonella survives",
      likelihood: "4",
      severity: "5",
      significant: "on",
      controlMeasures: "Cook to a core temperature",
      q1: "yes",
      q2: "yes",
    });
    expect(kill).toMatchObject({ classification: "CCP", treeResult: "CCP" });
    // Q1 yes, Q2 no, Q3 yes, Q4 yes (cooked later) → OPRP.
    const growth = await addHaccpHazard(qa, plan.id, {
      stepId: storage.id,
      type: "BIOLOGICAL",
      description: "Bacterial growth in raw chicken",
      likelihood: "3",
      severity: "4",
      significant: "on",
      q1: "yes",
      q2: "no",
      q3: "yes",
      q4: "yes",
    });
    expect(growth.classification).toBe("OPRP");

    const ccp = await saveHaccpControlPoint(qa, plan.id, kill.id, {
      criticalLimit: "Core temperature at least 75 °C",
      minValue: "75",
      unit: "°C",
      monitoring: "Probe the thickest piece of each batch",
      frequency: "Every batch",
      responsible: "Grill cook",
      correctiveAction: "Continue cooking until 75 °C; discard if not reached",
      verification: "Shift lead reviews the cooking log daily; probe calibrated monthly",
    });
    await linkHaccpCheckpoint(qa, plan.id, ccp.id, { checkpointId: cooker });
    await expectRule(
      approveHaccpPlan(ctx, plan.id, { reviewDueOn: future() }),
      "HACCP_PLAN_INCOMPLETE",
    ); // OPRP has no limits yet
    const oprp = await saveHaccpControlPoint(qa, plan.id, growth.id, {
      criticalLimit: "Stored at 5 °C or below",
      maxValue: "5",
      unit: "°C",
      monitoring: "Fridge temperature",
      frequency: "Twice a day",
      correctiveAction: "Move to another fridge; assess the product",
      verification: "Weekly log review",
    });
    // A fridge alarmed at 8 °C would let a 6 °C breach pass unnoticed.
    await expectRule(
      linkHaccpCheckpoint(qa, plan.id, oprp.id, { checkpointId: fridge }),
      "CHECKPOINT_OUTSIDE_LIMITS",
    );
    await linkHaccpCheckpoint(qa, plan.id, oprp.id, { checkpointId: coldRoom });

    await expectRule(
      approveHaccpPlan(qa, plan.id, { reviewDueOn: future() }),
      "HACCP_SELF_APPROVAL",
    );
    await expectRule(
      approveHaccpPlan(ctx, plan.id, { reviewDueOn: businessDate(ctx.timeZone) }),
      "REVIEW_DATE_PAST",
    );
    await approveHaccpPlan(ctx, plan.id, { reviewDueOn: future() });
    const view = await getHaccpPlan(qa, plan.id);
    expect(view.plan.status).toBe("APPROVED");
    expect(view.problems).toEqual([]);
    expect(view.steps.map((s) => s.name)).toEqual(["Receiving", "Cold storage", "Grilling"]);
    expect(view.steps[2].hazards[0].risk).toBe(20);

    // Fixed once approved, here and in the database.
    await expectRule(addHaccpStep(qa, plan.id, { name: "Serving" }), "HACCP_PLAN_NOT_DRAFT");
    await expect(
      getDb().haccpPlan.update({ where: { id: plan.id }, data: { name: "Changed" } }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      getDb().haccpStep.update({ where: { id: receiving.id }, data: { name: "Changed" } }),
    ).rejects.toThrow(/only a draft/);

    // An under-cooked batch: the reading opens a HIGH deviation tied to the CCP.
    const reading = await addRecord(ctx, {
      type: "TEMPERATURE",
      checkpointId: cooker,
      valueCelsius: "68",
      correctiveNote: "Returned to the grill",
    });
    expect(reading.inSpec).toBe(false);
    const nc = await getDb().nonConformance.findUniqueOrThrow({
      where: { id: reading.nonConformance!.id },
    });
    expect(nc.severity).toBe("HIGH");
    expect(nc.controlPointId).toBe(ccp.id);
    expect(nc.title).toContain("CCP deviation (CHK v1)");
    expect(nc.description).toContain("Planned corrective action: Continue cooking");
    // A fridge outside any plan keeps the usual severity.
    const other = await addRecord(ctx, {
      type: "TEMPERATURE",
      checkpointId: fridge,
      valueCelsius: "9",
      correctiveNote: "Door closed",
    });
    expect(
      (await getDb().nonConformance.findUniqueOrThrow({ where: { id: other.nonConformance!.id } }))
        .severity,
    ).toBe("MEDIUM");
    const evidence = await getHaccpPlan(ctx, plan.id);
    expect(evidence.deviations.map((d) => d.number)).toEqual([nc.number]);
    const cooking1 = evidence.steps[2].hazards[0].controlPoint!.checkpoints[0];
    expect([cooking1.readings, cooking1.outOfSpec]).toEqual([1, 1]);

    // A new version copies everything; the approved one stays in force until it is approved.
    const v2 = await newHaccpPlanVersion(qa, plan.id);
    expect(v2.version).toBe(2);
    await expectRule(newHaccpPlanVersion(qa, plan.id), "HACCP_DRAFT_EXISTS");
    const draft = await getHaccpPlan(qa, v2.id);
    expect(
      draft.steps
        .flatMap((s) => s.hazards)
        .map((h) => h.classification)
        .sort(),
    ).toEqual(["CCP", "OPRP", "PRP"]);
    expect(draft.steps[2].hazards[0].controlPoint!.checkpoints.map((c) => c.code)).toEqual([
      "COOK",
    ]);
    await approveHaccpPlan(ctx, v2.id, { reviewDueOn: future() });
    expect((await getHaccpPlan(ctx, plan.id)).plan.status).toBe("SUPERSEDED");
    const later = await addRecord(ctx, {
      type: "TEMPERATURE",
      checkpointId: cooker,
      valueCelsius: "70",
      correctiveNote: "Returned to the grill",
    });
    expect(
      (await getDb().nonConformance.findUniqueOrThrow({ where: { id: later.nonConformance!.id } }))
        .title,
    ).toContain("CHK v2");
    expect((await listHaccpPlans(qa)).map((p) => [p.code, p.version, p.status])).toEqual([
      ["CHK", 2, "APPROVED"],
    ]);
  });

  it("is for food safety people of this organization only", async () => {
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listHaccpPlans(cashier.ctx), "FORBIDDEN");
    await expectAppError(
      createHaccpPlan(cashier.ctx, { code: "X", name: "X", scope: "X" }),
      "FORBIDDEN",
    );
    const [plan] = await listHaccpPlans(ctx);
    const { ctx: other } = await createTenant("haccp-other");
    await expectAppError(getHaccpPlan(other, plan.id), "NOT_FOUND");
  });
});
