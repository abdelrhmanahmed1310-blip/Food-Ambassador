import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { createEmployee } from "@/modules/hr/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  acknowledgeReview,
  addGoal,
  closeCycle,
  createCycle,
  employeeGoals,
  finalizeReview,
  getCycle,
  getReview,
  launchCycle,
  myPerformance,
  skipReview,
  submitManagerReview,
  submitSelfReview,
  updateGoal,
} from "./service";

/** Goals and performance reviews (ADR-126). */

let ctx: TenantContext; // HR (the owner)
let today: string;
let maha: { id: string; ctx: TenantContext }; // head chef, Omar's manager
let omar: { id: string; ctx: TenantContext };
let lina: { id: string; ctx: TenantContext }; // no manager on record
let cycleId: string;
const goals: string[] = [];

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
const reviewOf = async (employeeId: string) =>
  (await getCycle(ctx, cycleId)).reviews.find((r) => r.employeeId === employeeId)!;

beforeAll(async () => {
  ({ ctx } = await createTenant("performance", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  today = businessDate(ctx.timeZone);
  const branchId = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  const person = async (first: string, managerId: string | null) => {
    const m = await addMember(ctx, "cashier", {}, `perf-${first.toLowerCase()}`);
    const e = await createEmployee(ctx, {
      firstName: first,
      lastName: "Test",
      jobTitle: "Staff",
      branchId,
      employmentType: "FULL_TIME",
      hireDate: "2025-01-01",
      managerId: managerId ?? "",
      userId: m.user.id,
    });
    return { id: e.id, ctx: m.ctx };
  };
  maha = await person("Maha", null);
  omar = await person("Omar", maha.id);
  lina = await person("Lina", null);
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("cycles and goals (ADR-126)", () => {
  it("sets weighted goals by the manager or HR, within 100 % a cycle", async () => {
    await expectAppError(
      createCycle(ctx, {
        name: "2026",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        selfDueOn: addDays(today, 10),
        managerDueOn: addDays(today, 5),
      }),
      "VALIDATION_FAILED",
    );
    cycleId = (
      await createCycle(ctx, {
        name: "2026 review",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        selfDueOn: addDays(today, 7),
        managerDueOn: addDays(today, 14),
      })
    ).id;
    // The manager sets Omar's goals; the cashier role holds no HR permission.
    goals.push(
      (await addGoal(maha.ctx, omar.id, { cycleId, title: "Cut waste by 10 %", weight: "60" })).id,
    );
    await expectRule(
      addGoal(maha.ctx, omar.id, { cycleId, title: "Too much", weight: "50" }),
      "GOAL_WEIGHTS_OVER_100",
    );
    goals.push(
      (await addGoal(maha.ctx, omar.id, { cycleId, title: "Train two juniors", weight: "40" })).id,
    );
    await expectAppError(
      addGoal(maha.ctx, lina.id, { title: "Not mine", weight: "10" }),
      "FORBIDDEN",
    );
    await expectAppError(
      addGoal(omar.ctx, omar.id, { title: "My own", weight: "10" }),
      "FORBIDDEN",
    );
    // Omar updates his progress but not the outcome.
    await updateGoal(omar.ctx, goals[0], { progress: "50" });
    await expectAppError(
      updateGoal(omar.ctx, goals[0], { progress: "50", status: "ACHIEVED" }),
      "FORBIDDEN",
    );
    expect(
      (await employeeGoals(omar.ctx, omar.id)).goals.find((g) => g.id === goals[0])?.progress,
    ).toBe(50);

    await expectRule(closeCycle(ctx, cycleId), "CYCLE_NOT_OPEN");
    expect((await launchCycle(ctx, cycleId)).reviews).toBe(3);
    await expectRule(launchCycle(ctx, cycleId), "CYCLE_NOT_DRAFT");
    expect((await reviewOf(omar.id)).reviewerEmployeeId).toBe(maha.id);
    // Maha's own self-review and Omar's review to give.
    expect(
      (await attentionItems(maha.ctx)).find((i) => i.key === "PERFORMANCE_REVIEWS_TO_DO")?.count,
    ).toBe(2);
  });
});

describe("reviews (ADR-126)", () => {
  it("runs self-review, manager rating, acknowledgement and HR's final rating", async () => {
    const id = (await reviewOf(omar.id)).id;
    await submitSelfReview(omar.ctx, id, {
      comment: "A good year in the kitchen",
      [`rating.${goals[0]}`]: "4",
      [`rating.${goals[1]}`]: "4",
    });
    await expectRule(
      submitSelfReview(omar.ctx, id, { comment: "Again" }),
      "REVIEW_STEP_NOT_ALLOWED",
    );
    // Omar cannot see the manager's part before it is given; Maha sees his self-review.
    expect((await getReview(omar.ctx, id)).review.managerRating).toBeNull();
    expect((await getReview(maha.ctx, id)).goals.map((g) => g.selfRating)).toEqual([4, 4]);
    await expectAppError(
      submitManagerReview(omar.ctx, id, { rating: "5", strengths: "Me", improvements: "None" }),
      "FORBIDDEN",
    );
    await expectRule(
      submitManagerReview(maha.ctx, id, {
        rating: "4",
        strengths: "Steady",
        improvements: "Plan ahead",
        [`rating.${goals[0]}`]: "5",
      }),
      "REVIEW_GOALS_UNRATED",
    );
    await submitManagerReview(maha.ctx, id, {
      rating: "4",
      strengths: "Steady, careful with waste",
      improvements: "Plan ahead for busy days",
      [`rating.${goals[0]}`]: "5",
      [`rating.${goals[1]}`]: "3",
    });
    const seen = await getReview(omar.ctx, id);
    expect([seen.review.managerRating, seen.score, seen.can.acknowledge]).toEqual([4, 4.2, true]);
    await acknowledgeReview(omar.ctx, id, { comment: "Agreed" });

    // HR finalizes; a different rating needs a reason. The manager is not HR.
    await expectAppError(finalizeReview(maha.ctx, id, {}), "FORBIDDEN");
    await expectRule(finalizeReview(ctx, id, { finalRating: "5" }), "REVIEW_CHANGE_NEEDS_REASON");
    await finalizeReview(ctx, id, {
      finalRating: "5",
      reason: "Calibrated with the other branches",
    });
    expect((await getReview(omar.ctx, id)).review.finalRating).toBe(5);
    await expect(
      getDb().performanceReview.update({ where: { id }, data: { finalRating: 1 } }),
    ).rejects.toThrow();
  });

  it("lets HR review those without a manager, and skip with a reason", async () => {
    const linaReview = (await reviewOf(lina.id)).id;
    await expectAppError(
      submitManagerReview(maha.ctx, linaReview, { rating: "3", strengths: "x", improvements: "y" }),
      "NOT_FOUND",
    );
    await submitManagerReview(ctx, linaReview, {
      rating: "3",
      strengths: "Friendly",
      improvements: "Speed",
    });
    await finalizeReview(ctx, linaReview, {});
    await expectRule(closeCycle(ctx, cycleId), "CYCLE_REVIEWS_OPEN");
    await skipReview(ctx, (await reviewOf(maha.id)).id, { reason: "On long leave" });
    await closeCycle(ctx, cycleId);
    const c = await getCycle(ctx, cycleId);
    expect(c.cycle.status).toBe("CLOSED");
    expect(c.distribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 });
    expect(c.byStatus).toEqual({ FINALIZED: 2, SKIPPED: 1 });
  });

  it("shows each person their own goals and reviews, and nobody else's", async () => {
    const mine = await myPerformance(omar.ctx);
    expect(mine.goals).toHaveLength(2);
    expect(mine.reviews.map((r) => r.finalRating)).toEqual([5]);
    await expectAppError(getReview(lina.ctx, (await reviewOf(omar.id)).id), "NOT_FOUND");
    await expectAppError(employeeGoals(lina.ctx, omar.id), "NOT_FOUND");
    await expectAppError(getCycle(lina.ctx, cycleId), "NOT_FOUND");
    const { ctx: other } = await createTenant("performance-other");
    await expectAppError(getCycle(other, cycleId), "NOT_FOUND");
  });
});
