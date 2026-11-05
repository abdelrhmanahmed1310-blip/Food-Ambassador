import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { createEmployee } from "@/modules/hr/service";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addQuestion,
  closeSurvey,
  createSurvey,
  giveRecognition,
  hideRecognition,
  openSurvey,
  recognitionWall,
  submitSurvey,
  surveyResults,
  surveysToAnswer,
} from "./service";

/** Anonymous surveys and recognition (ADR-127). */

let ctx: TenantContext; // HR
let olaya: string;
let malqa: string;
const staffA: Array<{ id: string; ctx: TenantContext }> = [];
let staffB: { id: string; ctx: TenantContext };
let surveyId: string;
let q: { enps: string; rating: string; text: string };

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
const answer = (who: TenantContext, enps: number, rating: number, text?: string) =>
  submitSurvey(who, surveyId, {
    [`q.${q.enps}`]: String(enps),
    [`q.${q.rating}`]: String(rating),
    ...(text ? { [`q.${q.text}`]: text } : {}),
  });

beforeAll(async () => {
  ({ ctx } = await createTenant("engagement", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  olaya = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  malqa = (await createBranch(ctx, { code: "MLQ", name: "Malqa", type: "RESTAURANT" })).id;
  const person = async (first: string, branchId: string, withUser = true) => {
    const m = withUser ? await addMember(ctx, "cashier", {}, `eng-${first.toLowerCase()}`) : null;
    const e = await createEmployee(ctx, {
      firstName: first,
      lastName: "Test",
      jobTitle: "Staff",
      branchId,
      employmentType: "FULL_TIME",
      hireDate: "2025-01-01",
      ...(m ? { userId: m.user.id } : {}),
    });
    return { id: e.id, ctx: m?.ctx as TenantContext };
  };
  for (const n of ["Ali", "Badr", "Dana", "Eman", "Fahd", "Ghada"])
    staffA.push(await person(n, olaya));
  staffB = await person("Hind", malqa);
  await person("Noacc", olaya, false); // no sign-in: cannot answer
}, 120_000);

afterAll(async () => {
  await getDb().$disconnect();
});

describe("surveys (ADR-127)", () => {
  it("is built as a draft and opened to staff who can sign in", async () => {
    surveyId = (await createSurvey(ctx, { title: "How are we doing?" })).id;
    await expectRule(openSurvey(ctx, surveyId), "SURVEY_NO_QUESTIONS");
    await addQuestion(ctx, surveyId, {
      type: "ENPS",
      text: "Would you recommend us as a place to work?",
      required: "on",
    });
    await addQuestion(ctx, surveyId, {
      type: "RATING",
      text: "I have what I need to do my job",
      required: "on",
    });
    await addQuestion(ctx, surveyId, { type: "TEXT", text: "Anything else?" });
    const s = await getDb().engagementQuestion.findMany({
      where: { surveyId },
      orderBy: { position: "asc" },
    });
    q = { enps: s[0].id, rating: s[1].id, text: s[2].id };
    expect((await openSurvey(ctx, surveyId)).audienceCount).toBe(7);
    await expectRule(
      addQuestion(ctx, surveyId, { type: "YES_NO", text: "Late" }),
      "SURVEY_NOT_DRAFT",
    );
    await expect(
      getDb().engagementQuestion.create({
        data: {
          organizationId: ctx.organizationId,
          surveyId,
          position: 9,
          type: "YES_NO",
          text: "Sneaky",
        },
      }),
    ).rejects.toThrow();
    expect((await surveysToAnswer(staffA[0].ctx)).map((x) => x.id)).toEqual([surveyId]);
    expect(
      (await attentionItems(staffA[0].ctx)).find((i) => i.key === "SURVEYS_TO_ANSWER")?.count,
    ).toBe(1);
  });

  it("takes one valid answer each, without recording who said what", async () => {
    await expectRule(
      submitSurvey(staffA[0].ctx, surveyId, { [`q.${q.enps}`]: "9" }),
      "SURVEY_ANSWER_REQUIRED",
    );
    await expectRule(answer(staffA[0].ctx, 11, 3), "SURVEY_ANSWER_INVALID");
    await answer(staffA[0].ctx, 10, 5, "More staff on Fridays");
    await expectAppError(answer(staffA[0].ctx, 10, 5), "CONFLICT");
    for (const [k, v] of [
      [1, [9, 4]],
      [2, [8, 4]],
      [3, [6, 2]],
    ] as const)
      await answer(staffA[k].ctx, v[0], v[1]);
    expect(await surveysToAnswer(staffA[0].ctx)).toEqual([]);

    // Four answers: nothing shown yet.
    let r = await surveyResults(ctx, surveyId);
    expect([r.responses, r.shown]).toEqual([4, false]);
    expect(r.questions[0]).not.toHaveProperty("enps");

    await answer(staffA[4].ctx, 3, 3, "Fix the fryer");
    await answer(staffB.ctx, 10, 5);
    r = await surveyResults(ctx, surveyId);
    expect([r.responses, r.shown, r.responseRate?.toFixed(2)]).toEqual([6, true, "0.86"]);
    // eNPS: promoters 10, 9, 10 (3), detractors 6, 3 (2) of 6 → 17.
    expect(r.questions[0].enps).toMatchObject({ score: 17, promoters: 3, detractors: 2 });
    expect(r.questions[1].rating?.average).toBe(3.83);
    expect([...(r.questions[2].texts ?? [])].sort()).toEqual([
      "Fix the fryer",
      "More staff on Fridays",
    ]);
    // Only Olaya has five answers: Malqa's single answer is not broken out.
    expect(r.questions[0].byBranch?.map((b) => b.branch)).toEqual(["OLY — Olaya"]);

    // Nothing links a person to their answers: no employee on a response, no audit of answering.
    const cols = await getDb().$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'engagement_responses'`;
    expect(cols.map((c) => c.column_name)).not.toContain("employee_id");
    const audits = await getDb().auditEvent.count({
      where: {
        organizationId: ctx.organizationId,
        actorUserId: { in: staffA.map((s) => s.ctx.userId) },
      },
    });
    expect(audits).toBe(0);
    expect(await getDb().engagementParticipation.count({ where: { surveyId } })).toBe(6);
  });

  it("shows branch managers only their branch's answers, from five", async () => {
    const olayaMgr = await addMember(ctx, "branch_manager", {
      scopeType: "BRANCH",
      branchId: olaya,
    });
    const malqaMgr = await addMember(ctx, "branch_manager", {
      scopeType: "BRANCH",
      branchId: malqa,
    });
    expect(await surveyResults(olayaMgr.ctx, surveyId)).toMatchObject({
      responses: 5,
      shown: true,
    });
    expect(await surveyResults(malqaMgr.ctx, surveyId)).toMatchObject({
      responses: 1,
      shown: false,
    });
    await expectAppError(closeSurvey(olayaMgr.ctx, surveyId), "NOT_FOUND");
    await expectAppError(surveyResults(staffA[0].ctx, surveyId), "FORBIDDEN");
    const { ctx: other } = await createTenant("engagement-other");
    await expectAppError(surveyResults(other, surveyId), "NOT_FOUND");
  });

  it("closes, and takes no more answers", async () => {
    await closeSurvey(ctx, surveyId);
    await expectRule(answer(staffA[5].ctx, 9, 4), "SURVEY_NOT_OPEN");
  });
});

describe("recognition (ADR-127)", () => {
  it("lets colleagues thank each other, and HR hide what does not belong", async () => {
    await expectRule(
      giveRecognition(staffA[0].ctx, {
        toEmployeeId: staffA[0].id,
        value: "TEAMWORK",
        message: "Me",
      }),
      "RECOGNITION_SELF",
    );
    const r = await giveRecognition(staffA[0].ctx, {
      toEmployeeId: staffA[1].id,
      value: "FOOD_SAFETY",
      message: "Caught the fridge alarm at closing",
    });
    const wall = await recognitionWall(staffB.ctx);
    expect(wall.posts.map((p) => [p.value, p.to.firstName, p.from.firstName])).toEqual([
      ["FOOD_SAFETY", "Badr", "Ali"],
    ]);
    const mgr = await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: olaya });
    await expectAppError(hideRecognition(mgr.ctx, r.id, { reason: "x" }), "FORBIDDEN");
    await hideRecognition(ctx, r.id, { reason: "Duplicate" });
    expect((await recognitionWall(staffB.ctx)).posts).toEqual([]);
    expect((await recognitionWall(ctx)).posts.map((p) => p.hiddenReason)).toEqual(["Duplicate"]);
  });
});
