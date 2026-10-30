import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addCorrectiveAction,
  closeNonConformance,
  completeAction,
  getNonConformance,
  listNonConformances,
  raiseNonConformance,
  startInvestigation,
  verifyAction,
} from "./nonconformances";
import {
  addChecklistItem,
  addRecord,
  completeChecklist,
  createCheckpoint,
  createTemplate,
  getRun,
  getTemplate,
  listCheckpoints,
  listRecords,
  removeChecklistItem,
  setCheckpointArchived,
} from "./service";

let ctx: TenantContext;
let zamalek: string;
let maadi: string;
let fridge: string;
let freezer: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("safety"));
  zamalek = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" })).id;
  maadi = (await createBranch(ctx, { code: "MAA", name: "Maadi", type: "RESTAURANT" })).id;
  fridge = (
    await createCheckpoint(ctx, {
      branchId: zamalek,
      code: "F1",
      name: "Walk-in fridge",
      kind: "FRIDGE",
      minCelsius: "0",
      maxCelsius: "5",
    })
  ).id;
  freezer = (
    await createCheckpoint(ctx, {
      branchId: zamalek,
      code: "Z1",
      name: "Freezer",
      kind: "FREEZER",
      maxCelsius: "-18",
    })
  ).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("food safety records", () => {
  it("judges temperatures against the limits at the time and opens a non-conformance when out of spec", async () => {
    const ok = await addRecord(ctx, {
      type: "TEMPERATURE",
      checkpointId: fridge,
      valueCelsius: "4.5",
    });
    expect(ok).toMatchObject({ inSpec: true, nonConformance: null });
    await expectAppError(
      addRecord(ctx, { type: "TEMPERATURE", checkpointId: fridge, valueCelsius: "7" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const warm = await addRecord(ctx, {
      type: "TEMPERATURE",
      checkpointId: fridge,
      valueCelsius: "7",
      correctiveNote: "Door was open; closed, moved dairy to the second fridge",
    });
    expect(warm.inSpec).toBe(false);
    expect(warm.nonConformance?.number).toMatch(/^NC-\d{4}-\d{6}$/);
    const nc = await getNonConformance(ctx, warm.nonConformance!.id);
    expect(nc).toMatchObject({ source: "RECORD", status: "OPEN", severity: "MEDIUM" });
    expect(nc.records).toHaveLength(1);
    expect(
      (await addRecord(ctx, { type: "TEMPERATURE", checkpointId: freezer, valueCelsius: "-20" }))
        .inSpec,
    ).toBe(true);
    const records = await listRecords(ctx, { outOfSpec: true });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ minCelsius: expect.anything(), checkpoint: { code: "F1" } });
    // Records are evidence: they cannot be deleted.
    await expect(getDb().foodSafetyRecord.delete({ where: { id: ok.id } })).rejects.toThrow();
    const cps = await listCheckpoints(ctx);
    expect(cps.find((c) => c.id === fridge)?.last?.inSpec).toBe(false);
  });

  it("records pass/fail checks and refuses bad input", async () => {
    expect(
      (await addRecord(ctx, { type: "CLEANING", branchId: zamalek, passed: "yes" })).inSpec,
    ).toBe(true);
    const failed = await addRecord(ctx, {
      type: "PEST_CONTROL",
      branchId: zamalek,
      passed: "no",
      correctiveNote: "Called the contractor",
    });
    expect(failed.nonConformance).not.toBeNull();
    await expectAppError(
      addRecord(ctx, { type: "HYGIENE", branchId: zamalek }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      addRecord(ctx, { type: "TEMPERATURE", checkpointId: fridge }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createCheckpoint(ctx, { branchId: zamalek, code: "X", name: "No limits", kind: "OTHER" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createCheckpoint(ctx, {
        branchId: zamalek,
        code: "F1",
        name: "Again",
        kind: "FRIDGE",
        maxCelsius: "5",
      }),
      "CONFLICT",
    );
    await setCheckpointArchived(ctx, freezer, true);
    await expectAppError(
      addRecord(ctx, { type: "TEMPERATURE", checkpointId: freezer, valueCelsius: "-20" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });
});

describe("checklists", () => {
  it("snapshots items into runs and opens one non-conformance for failures", async () => {
    const tpl = await createTemplate(ctx, { name: "Opening checks" });
    await addChecklistItem(ctx, tpl.id, { text: "Hand-wash station stocked", kind: "YES_NO" });
    await addChecklistItem(ctx, tpl.id, {
      text: "Dishwasher rinse °C",
      kind: "NUMBER",
      minValue: "82",
    });
    await expectAppError(
      addChecklistItem(ctx, tpl.id, { text: "Bad", kind: "YES_NO", minValue: "1" }),
      "VALIDATION_FAILED",
    );
    const [wash, rinse] = (await getTemplate(ctx, tpl.id)).items;
    await expectAppError(
      completeChecklist(ctx, tpl.id, {
        branchId: zamalek,
        answers: [{ itemId: wash.id, yes: "yes" }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    const good = await completeChecklist(ctx, tpl.id, {
      branchId: zamalek,
      answers: [
        { itemId: wash.id, yes: "yes" },
        { itemId: rinse.id, value: "85" },
      ],
    });
    expect(good).toMatchObject({ failed: 0, nonConformance: null });
    const bad = await completeChecklist(ctx, tpl.id, {
      branchId: zamalek,
      answers: [
        { itemId: wash.id, yes: "no", note: "No soap" },
        { itemId: rinse.id, value: "70" },
      ],
    });
    expect(bad.failed).toBe(2);
    expect((await getNonConformance(ctx, bad.nonConformance!.id)).severity).toBe("HIGH");
    // Changing the template later does not change the run.
    await removeChecklistItem(ctx, tpl.id, rinse.id);
    const run = await getRun(ctx, bad.id);
    expect(run.answers.map((a) => [a.text, a.ok])).toEqual([
      ["Hand-wash station stocked", false],
      ["Dishwasher rinse °C", false],
    ]);
    await expect(
      getDb().checklistAnswer.updateMany({ where: { runId: bad.id }, data: { ok: true } }),
    ).rejects.toThrow();
  });
});

describe("non-conformances", () => {
  it("investigates, plans, does and verifies actions by different people, then closes", async () => {
    const quality = await addMember(ctx, "food_safety");
    const nc = await raiseNonConformance(ctx, {
      branchId: zamalek,
      title: "Raw chicken above cooked food",
      description: "Found in walk-in",
      severity: "HIGH",
    });
    await startInvestigation(ctx, nc.id, { rootCause: "Shelf labels missing" });
    expect((await getNonConformance(ctx, nc.id)).status).toBe("INVESTIGATING");
    await addCorrectiveAction(ctx, nc.id, {
      description: "Label shelves",
      ownerUserId: quality.user.id,
      dueOn: "2020-01-01",
    });
    let view = await getNonConformance(ctx, nc.id);
    expect(view.status).toBe("ACTION_PLANNED");
    expect(view.actions[0]).toMatchObject({ overdue: true, owner: expect.any(String) });
    expect(
      (await listNonConformances(ctx, { open: true })).find((r) => r.id === nc.id)?.overdue,
    ).toBe(1);
    await expectAppError(
      closeNonConformance(ctx, nc.id, { note: "Done" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const actionId = view.actions[0].id;
    await expectAppError(
      verifyAction(ctx, nc.id, actionId, { note: "ok" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await completeAction(ctx, nc.id, actionId, { note: "Labels on all shelves" });
    await expectAppError(
      verifyAction(ctx, nc.id, actionId, { note: "Self check" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await verifyAction(quality.ctx, nc.id, actionId, { note: "Checked on site" });
    view = await getNonConformance(ctx, nc.id);
    expect(view.actions[0]).toMatchObject({ status: "VERIFIED", overdue: false });
    await closeNonConformance(ctx, nc.id, { note: "Effective" });
    expect((await getNonConformance(ctx, nc.id)).status).toBe("CLOSED");
    await expectAppError(
      addCorrectiveAction(ctx, nc.id, { description: "More" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      addCorrectiveAction(
        ctx,
        (
          await raiseNonConformance(ctx, {
            branchId: zamalek,
            title: "x",
            description: "y",
            severity: "LOW",
          })
        ).id,
        {
          description: "z",
          ownerUserId: (await createTenant("outsider")).owner.id,
        },
      ),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("keeps each branch's records to its own people and other tenants out", async () => {
    const maadiCook = await addMember(ctx, "warehouse", { scopeType: "BRANCH", branchId: maadi });
    await expectAppError(
      addRecord(maadiCook.ctx, { type: "TEMPERATURE", checkpointId: fridge, valueCelsius: "3" }),
      "NOT_FOUND",
    );
    expect(await listRecords(maadiCook.ctx)).toEqual([]);
    expect((await listNonConformances(maadiCook.ctx)).length).toBe(0);
    expect(
      (await addRecord(maadiCook.ctx, { type: "CLEANING", branchId: maadi, passed: "yes" })).inSpec,
    ).toBe(true);
    await expectAppError(
      createCheckpoint(maadiCook.ctx, {
        branchId: maadi,
        code: "F9",
        name: "Fridge",
        kind: "FRIDGE",
        maxCelsius: "5",
      }),
      "FORBIDDEN",
    );
    const finance = await addMember(ctx, "finance");
    await expectAppError(listRecords(finance.ctx), "FORBIDDEN");
    const other = await createTenant("safety-other");
    await expectAppError(
      addRecord(other.ctx, { type: "TEMPERATURE", checkpointId: fridge, valueCelsius: "3" }),
      "NOT_FOUND",
    );
    const nc = (await listNonConformances(ctx))[0];
    await expectAppError(getNonConformance(other.ctx, nc.id), "NOT_FOUND");
  });
});
