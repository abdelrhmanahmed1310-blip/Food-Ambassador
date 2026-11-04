import { beforeAll, describe, expect, it } from "vitest";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { businessDate } from "@/modules/inventory/rules";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { branchCompliance } from "./compliance";
import { createEquipment, recordCalibration } from "./equipment";
import { addCorrectiveAction, completeAction } from "./nonconformances";
import {
  addChecklistItem,
  addRecord,
  completeChecklist,
  createCheckpoint,
  createTemplate,
} from "./service";

/** Compliance score per branch (ADR-100). */

let ctx: TenantContext;
let cairo: string;
let giza: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("compliance"));
  cairo = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  giza = (await createBranch(ctx, { code: "GIZ", name: "Giza", type: "RESTAURANT" })).id;
});

describe("branch compliance (ADR-100)", () => {
  it("scores each branch from its own records, with no score where nothing was recorded", async () => {
    const today = businessDate(ctx.timeZone);
    const fridge = (
      await createCheckpoint(ctx, {
        branchId: cairo,
        code: "FR1",
        name: "Fridge",
        kind: "FRIDGE",
        maxCelsius: "5",
      })
    ).id;
    // 3 of 4 readings in spec; the warm one opens an NC.
    for (const v of ["3", "4", "2"])
      await addRecord(ctx, { type: "TEMPERATURE", checkpointId: fridge, valueCelsius: v });
    const warm = await addRecord(ctx, {
      type: "TEMPERATURE",
      checkpointId: fridge,
      valueCelsius: "9",
      correctiveNote: "Moved stock to the walk-in",
    });
    const ncId = (warm as { nonConformance: { id: string } }).nonConformance.id;
    // Two actions due today: one done, one not.
    await addCorrectiveAction(ctx, ncId, { description: "Service the fridge", dueOn: today });
    await addCorrectiveAction(ctx, ncId, { description: "Retrain staff", dueOn: today });
    const actions = await getDb().correctiveAction.findMany({
      where: { nonConformanceId: ncId },
      orderBy: { createdAt: "asc" },
    });
    await completeAction(ctx, ncId, actions[0].id, { note: "Done by Cool Tech" });
    // Checklist: 1 of 2 items OK.
    const template = (await createTemplate(ctx, { name: "Opening" })).id;
    await addChecklistItem(ctx, template, { text: "Hand soap", kind: "YES_NO" });
    await addChecklistItem(ctx, template, { text: "Sanitizer", kind: "YES_NO" });
    const items = await getDb().checklistItem.findMany({
      where: { templateId: template },
      orderBy: { position: "asc" },
    });
    await completeChecklist(ctx, template, {
      branchId: cairo,
      answers: [
        { itemId: items[0].id, yes: "yes" },
        { itemId: items[1].id, yes: "no" },
      ],
    });
    // Equipment: one calibrated, one planned but never calibrated.
    const probe = await createEquipment(ctx, {
      branchId: cairo,
      code: "P1",
      name: "Probe",
      type: "THERMOMETER",
      calibrationIntervalDays: "90",
    });
    await recordCalibration(ctx, probe.id, {
      performedOn: today,
      performedBy: "QA",
      result: "PASS",
    });
    await createEquipment(ctx, {
      branchId: cairo,
      code: "P2",
      name: "Probe 2",
      type: "THERMOMETER",
      calibrationIntervalDays: "90",
    });

    const r = await branchCompliance(ctx, { days: 30 });
    const c = r.branches.find((b) => b.branch.id === cairo)!;
    expect(c.components.map((x) => [x.key, x.passed, x.counted, x.percent])).toEqual([
      ["RECORDS_IN_SPEC", 3, 4, 75],
      ["CHECKLIST_ITEMS_OK", 1, 2, 50],
      ["ACTIONS_ON_TIME", 1, 2, 50],
      ["EQUIPMENT_CALIBRATED", 1, 2, 50],
    ]);
    // (75 + 50 + 50 + 50) / 4 = 56.25
    expect(c.overall).toBe(56);
    const g = r.branches.find((b) => b.branch.id === giza)!;
    expect(g.overall).toBeNull();
    expect(g.components.every((x) => x.percent === null)).toBe(true);
    // An unknown period falls back to 30 days.
    expect((await branchCompliance(ctx, { days: 12 })).days).toBe(30);
  });

  it("only shows branches the user may see", async () => {
    const giZaStaff = await addMember(ctx, "warehouse", { scopeType: "BRANCH", branchId: giza });
    const r = await branchCompliance(giZaStaff.ctx);
    expect(r.branches.map((b) => b.branch.code)).toEqual(["GIZ"]);
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(branchCompliance(cashier.ctx), "FORBIDDEN");
  });
});
