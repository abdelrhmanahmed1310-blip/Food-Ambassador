import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { createEmployee } from "@/modules/hr/service";
import { addTemplateTask, createOnboardingTemplate } from "@/modules/rosters/onboarding";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addApplication,
  closeOpening,
  decideOpening,
  eraseCandidate,
  getApplication,
  getCandidate,
  getOpening,
  hireCandidate,
  listCandidates,
  moveApplication,
  myInterviews,
  purgeCandidates,
  requestOpening,
  scheduleInterview,
  setPosition,
  setRecruitmentSettings,
  submitScorecard,
  workforcePlan,
} from "./service";

/** Recruitment and workforce planning (ADR-129). */

let ctx: TenantContext; // owner: organization-wide HR
let hr2: TenantContext; // a second organization-wide HR person
let olaya: string;
let malqa: string;
let olayaMgr: { ctx: TenantContext; userId: string };
let malqaMgr: TenantContext;
let interviewer: { ctx: TenantContext; userId: string };
let openingId: string;
let sara: string; // application
let omar: string; // application
let templateId: string;

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

beforeAll(async () => {
  ({ ctx } = await createTenant("recruitment", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  olaya = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  malqa = (await createBranch(ctx, { code: "MLQ", name: "Malqa", type: "RESTAURANT" })).id;
  hr2 = (await addMember(ctx, "admin", {}, "rec-hr2")).ctx;
  const om = await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: olaya });
  olayaMgr = { ctx: om.ctx, userId: om.user.id };
  malqaMgr = (await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: malqa })).ctx;
  const iv = await addMember(ctx, "cashier", {}, "rec-interviewer");
  interviewer = { ctx: iv.ctx, userId: iv.user.id };
  for (const first of ["Ali", "Badr"])
    await createEmployee(ctx, {
      firstName: first,
      lastName: "Cook",
      jobTitle: "Line  cook",
      branchId: olaya,
      employmentType: "FULL_TIME",
      hireDate: "2025-01-01",
    });
  templateId = (await createOnboardingTemplate(ctx, { code: "NEW", name: "New starter" })).id;
  await addTemplateTask(ctx, templateId, { title: "Contract", dueDays: "0", assignee: "HR" });
}, 120_000);

afterAll(async () => {
  await getDb().$disconnect();
});

describe("workforce plan and openings (ADR-129)", () => {
  it("plans positions per branch and title; only HR at the branch sets them", async () => {
    await expectAppError(
      setPosition(olayaMgr.ctx, { branchId: olaya, jobTitle: "Line cook", plannedHeadcount: "4" }),
      "FORBIDDEN",
    );
    await setPosition(ctx, { branchId: olaya, jobTitle: "Line cook", plannedHeadcount: "3" });
    await setPosition(ctx, { branchId: olaya, jobTitle: "line COOK", plannedHeadcount: "4" });
    const plan = await workforcePlan(ctx);
    expect(plan.rows.map((r) => [r.jobTitle, r.planned, r.filled, r.gap])).toEqual([
      ["line COOK", 4, 2, 2],
    ]);
  });

  it("is requested by the branch and approved by someone else in HR", async () => {
    await expectAppError(
      requestOpening(malqaMgr, {
        branchId: olaya,
        jobTitle: "Line cook",
        employmentType: "FULL_TIME",
        headcount: "1",
        reason: "NEW_POSITION",
      }),
      "FORBIDDEN",
    );
    const o = await requestOpening(olayaMgr.ctx, {
      branchId: olaya,
      jobTitle: "Line cook",
      employmentType: "FULL_TIME",
      headcount: "3",
      reason: "NEW_POSITION",
    });
    openingId = o.id;
    // Two places are in the plan; the third is beyond it.
    expect([o.number.startsWith("JOB-"), o.status, o.beyondPlan]).toEqual([
      true,
      "PENDING_APPROVAL",
      1,
    ]);
    expect((await attentionItems(ctx)).find((i) => i.key === "OPENINGS_TO_APPROVE")?.count).toBe(1);
    await expectAppError(
      decideOpening(olayaMgr.ctx, openingId, { decision: "APPROVE" }),
      "FORBIDDEN",
    );
    const own = await requestOpening(ctx, {
      branchId: malqa,
      jobTitle: "Cashier",
      employmentType: "PART_TIME",
      headcount: "1",
      reason: "SEASONAL",
    });
    await expectRule(decideOpening(ctx, own.id, { decision: "APPROVE" }), "OPENING_SELF_APPROVAL");
    await decideOpening(hr2, own.id, { decision: "REJECT", note: "Not this season" });
    await decideOpening(ctx, openingId, { decision: "APPROVE" });
    await expectRule(decideOpening(hr2, openingId, { decision: "REJECT" }), "OPENING_NOT_PENDING");
    // In recruitment now: the gap closes.
    expect((await workforcePlan(ctx)).rows[0]).toMatchObject({ inRecruitment: 3, gap: -1 });
    await expectAppError(getOpening(malqaMgr, openingId), "NOT_FOUND");
  });
});

describe("candidates and the pipeline (ADR-129)", () => {
  it("adds candidates to the opening, once, and moves them through the stages", async () => {
    sara = (
      await addApplication(olayaMgr.ctx, openingId, {
        firstName: "Sara",
        lastName: "Haddad",
        email: "Sara@example.com",
        phone: "+966 5000 0000",
        source: "REFERRAL",
      })
    ).id;
    omar = (
      await addApplication(olayaMgr.ctx, openingId, {
        firstName: "Omar",
        lastName: "Nasser",
        source: "WALK_IN",
      })
    ).id;
    await expectAppError(
      addApplication(olayaMgr.ctx, openingId, {
        firstName: "Sara",
        lastName: "Again",
        email: "sara@example.com",
        source: "OTHER",
      }),
      "CONFLICT",
    );
    const opening = await getOpening(olayaMgr.ctx, openingId);
    expect(opening.applications).toHaveLength(2);
    // Names and contact details stay out of the audit log.
    const audits = await getDb().auditEvent.findMany({
      where: { organizationId: ctx.organizationId, action: "candidate.created" },
    });
    expect(JSON.stringify(audits)).not.toContain("Haddad");

    await expectRule(moveApplication(olayaMgr.ctx, sara, { to: "OFFER" }), "APPLICATION_MOVE");
    await moveApplication(olayaMgr.ctx, sara, { to: "SCREENING" });
    await expectAppError(moveApplication(malqaMgr, sara, { to: "INTERVIEW" }), "NOT_FOUND");
    await moveApplication(olayaMgr.ctx, omar, { to: "REJECTED", note: "No experience" });
    await expectRule(moveApplication(olayaMgr.ctx, omar, { to: "SCREENING" }), "APPLICATION_MOVE");
  });

  it("schedules an interview the interviewer scores once it has happened", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const past = await scheduleInterview(olayaMgr.ctx, sara, {
      kind: "TRIAL_SHIFT",
      date: yesterday,
      time: "10:00",
      interviewerUserId: interviewer.userId,
      location: "Olaya kitchen",
    });
    // Screening moves to interview with the first one.
    expect((await getApplication(ctx, sara)).application.stage).toBe("INTERVIEW");
    const later = await scheduleInterview(olayaMgr.ctx, sara, {
      kind: "IN_PERSON",
      date: tomorrow,
      time: "10:00",
      interviewerUserId: olayaMgr.userId,
    });
    expect(
      (await attentionItems(interviewer.ctx)).find((i) => i.key === "INTERVIEWS_TO_SCORE")?.count,
    ).toBe(1);
    expect((await myInterviews(interviewer.ctx)).map((i) => i.mayScore)).toEqual([true]);
    await expectAppError(
      submitScorecard(olayaMgr.ctx, past.id, { rating: "4", recommendation: "HIRE" }),
      "NOT_FOUND",
    );
    await expectRule(
      submitScorecard(olayaMgr.ctx, later.id, { rating: "4", recommendation: "HIRE" }),
      "INTERVIEW_NOT_YET",
    );
    await submitScorecard(interviewer.ctx, past.id, {
      rating: "4",
      recommendation: "HIRE",
      notes: "Fast and clean",
    });
    await expectRule(
      submitScorecard(interviewer.ctx, past.id, { rating: "5", recommendation: "HIRE" }),
      "INTERVIEW_NOT_SCHEDULED",
    );
    expect((await getApplication(ctx, sara)).scorecards).toMatchObject({
      count: 1,
      average: 4,
      hire: 1,
    });
  });

  it("hires at the offer stage into an employee, with onboarding, by HR", async () => {
    await expectRule(hireCandidate(ctx, sara, { hireDate: "2026-12-01" }), "HIRE_NOT_OFFER");
    await moveApplication(olayaMgr.ctx, sara, { to: "OFFER" });
    await expectAppError(
      hireCandidate(olayaMgr.ctx, sara, { hireDate: "2026-12-01" }),
      "FORBIDDEN",
    );
    const r = await hireCandidate(ctx, sara, {
      hireDate: "2026-12-01",
      onboardingTemplateId: templateId,
    });
    expect(r.filled).toBe(false);
    const e = await getDb().employee.findUniqueOrThrow({ where: { id: r.employeeId } });
    expect([e.firstName, e.lastName, e.email, e.jobTitle, e.branchId]).toEqual([
      "Sara",
      "Haddad",
      "sara@example.com",
      "Line cook",
      olaya,
    ]);
    expect(await getDb().onboardingChecklist.count({ where: { employeeId: e.id } })).toBe(1);
    const o = (await getOpening(ctx, openingId)).opening;
    expect([o.hired, o.status]).toEqual([1, "OPEN"]);
    // A hired application is final, in the database too.
    await expect(
      getDb().jobApplication.update({ where: { id: sara }, data: { stage: "OFFER" } }),
    ).rejects.toThrow();
    // Sara is in post now.
    expect((await workforcePlan(ctx)).rows[0]).toMatchObject({
      filled: 3,
      inRecruitment: 2,
      gap: -1,
    });
  });

  it("closes an opening only once nobody is left in play", async () => {
    const ali = (
      await addApplication(olayaMgr.ctx, openingId, {
        firstName: "Hadi",
        lastName: "Saleh",
        source: "AGENCY",
      })
    ).id;
    await expectRule(
      closeOpening(olayaMgr.ctx, openingId, { reason: "Enough" }),
      "OPENING_HAS_CANDIDATES",
    );
    await moveApplication(olayaMgr.ctx, ali, { to: "WITHDRAWN", note: "Took another job" });
    await closeOpening(olayaMgr.ctx, openingId, { reason: "Two are enough" });
    await expectRule(
      addApplication(olayaMgr.ctx, openingId, {
        firstName: "Late",
        lastName: "One",
        source: "OTHER",
      }),
      "OPENING_NOT_OPEN",
    );
  });
});

describe("candidate data (ADR-129)", () => {
  it("is erased by HR by hand or after the retention days, keeping the counts", async () => {
    const omarCandidate = (await getApplication(ctx, omar)).application.candidateId;
    await expectAppError(eraseCandidate(olayaMgr.ctx, omarCandidate), "FORBIDDEN");
    await eraseCandidate(ctx, omarCandidate);
    const erased = (await getCandidate(ctx, omarCandidate)).candidate;
    expect([erased.firstName, erased.email, erased.erasedAt !== null]).toEqual(["—", null, true]);
    expect((await getApplication(ctx, omar)).application.closeNote).toBeNull();

    // Retention: Hadi (withdrawn) untouched for 200 days goes; nobody active does.
    await expectAppError(
      setRecruitmentSettings(olayaMgr.ctx, { candidateRetentionDays: "180" }),
      "FORBIDDEN",
    );
    await expectAppError(
      setRecruitmentSettings(ctx, { candidateRetentionDays: "5" }),
      "VALIDATION_FAILED",
    );
    await setRecruitmentSettings(ctx, { candidateRetentionDays: "180" });
    const hadi = (await listCandidates(ctx, "Hadi"))[0];
    await getDb().candidate.update({
      where: { id: hadi.id },
      data: { lastActivityAt: new Date(Date.now() - 200 * 86_400_000) },
    });
    expect((await purgeCandidates()).erased).toBeGreaterThanOrEqual(1);
    expect((await getCandidate(ctx, hadi.id)).candidate.erasedAt).not.toBeNull();
    // Sara was hired: her employee record stays as it is.
    expect(
      await getDb().employee.count({
        where: { organizationId: ctx.organizationId, firstName: "Sara" },
      }),
    ).toBe(1);

    const { ctx: other } = await createTenant("recruitment-other");
    await expectAppError(getCandidate(other, hadi.id), "NOT_FOUND");
  });
});
