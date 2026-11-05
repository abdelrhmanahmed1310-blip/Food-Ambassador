import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  ANONYMITY_MIN,
  enps,
  mayShow,
  QUESTION_TYPES,
  RECOGNITION_VALUES,
  ratingSummary,
  shuffled,
  validAnswer,
  type QuestionType,
} from "./rules";

/**
 * Staff engagement (DECISIONS.md ADR-127): anonymous surveys with eNPS and
 * a recognition wall. Answers are never linked to the person: a separate
 * participation row only says that someone answered, response ids are
 * random and only the day is kept, nothing about a submission is audited,
 * and results show only from five answers (per branch too).
 */

const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });
const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .pipe(z.uuid().optional());

export const canViewEngagement = (ctx: TenantContext) =>
  holdsAnyGrant(ctx.grants, "engagement.view") || holdsAnyGrant(ctx.grants, "engagement.manage");
const manageAt = (ctx: TenantContext, branchId: string | null) =>
  branchId
    ? hasPermission(ctx.grants, "engagement.manage", { branchId })
    : hasPermission(ctx.grants, "engagement.manage");
function viewBranches(ctx: TenantContext): string[] | null {
  const v = accessibleScope(ctx.grants, "engagement.view");
  const m = accessibleScope(ctx.grants, "engagement.manage");
  if (v.all || m.all) return null;
  return [...new Set([...v.branchIds, ...m.branchIds])];
}

async function me(tx: Tx, ctx: TenantContext) {
  return tx.employee.findFirst({
    where: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      status: { not: "TERMINATED" },
    },
    select: { id: true, branchId: true },
  });
}

// ─── Surveys (HR) ───

export async function createSurvey(ctx: TenantContext, rawInput: unknown) {
  const parsed = z
    .object({
      title: requiredText(160),
      intro: optionalText(1000),
      branchId: optionalUuid,
      closesOn: optionalDate,
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const s = parsed.data;
  if (!manageAt(ctx, s.branchId ?? null)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    if (s.branchId) {
      const b = await tx.branch.findFirst({
        where: { organizationId: ctx.organizationId, id: s.branchId, archivedAt: null },
      });
      if (!b) throw notFound("Branch");
    }
    const survey = await tx.engagementSurvey.create({
      data: {
        organizationId: ctx.organizationId,
        title: s.title,
        intro: s.intro,
        branchId: s.branchId ?? null,
        closesOn: s.closesOn ? asDate(s.closesOn) : null,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "engagement_survey.created",
      entityType: "engagement_survey",
      entityId: survey.id,
      changes: { title: s.title },
    });
    return survey;
  });
}

async function loadSurvey(tx: Tx, ctx: TenantContext, surveyId: string) {
  const s = await tx.engagementSurvey.findFirst({
    where: { organizationId: ctx.organizationId, id: surveyId },
    include: { questions: { orderBy: { position: "asc" } } },
  });
  if (!s) throw notFound("Survey");
  return s;
}

async function managedSurvey(tx: Tx, ctx: TenantContext, surveyId: string) {
  const s = await loadSurvey(tx, ctx, surveyId);
  if (!manageAt(ctx, s.branchId)) throw notFound("Survey");
  return s;
}

export async function addQuestion(ctx: TenantContext, surveyId: string, rawInput: unknown) {
  const parsed = z
    .object({
      type: z.enum(QUESTION_TYPES, { error: "invalidOption" }),
      text: requiredText(300),
      required: z
        .string()
        .optional()
        .transform((v) => v === "on" || v === "true"),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await managedSurvey(tx, ctx, surveyId);
    if (s.status !== "DRAFT")
      throw businessRuleViolation("SURVEY_NOT_DRAFT", "The survey is no longer a draft");
    if (s.questions.length >= 50)
      throw businessRuleViolation("SURVEY_TOO_LONG", "At most 50 questions");
    await tx.engagementQuestion.create({
      data: {
        organizationId: ctx.organizationId,
        surveyId: s.id,
        position: s.questions.length + 1,
        type: parsed.data.type,
        text: parsed.data.text,
        required: parsed.data.required,
      },
    });
  });
}

export async function removeQuestion(ctx: TenantContext, questionId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const q = await tx.engagementQuestion.findFirst({
      where: { organizationId: ctx.organizationId, id: questionId },
    });
    if (!q) throw notFound("Question");
    const s = await managedSurvey(tx, ctx, q.surveyId);
    if (s.status !== "DRAFT")
      throw businessRuleViolation("SURVEY_NOT_DRAFT", "The survey is no longer a draft");
    await tx.engagementQuestion.delete({ where: { id: q.id } });
    // Keep positions 1..n.
    let n = 0;
    for (const x of s.questions.filter((x) => x.id !== q.id))
      await tx.engagementQuestion.update({ where: { id: x.id }, data: { position: ++n } });
  });
}

/** Staff who can answer: active employees with a sign-in, in the survey's branch or all. */
const audienceWhere = (ctx: TenantContext, branchId: string | null) => ({
  organizationId: ctx.organizationId,
  status: { not: "TERMINATED" as const },
  userId: { not: null },
  ...(branchId ? { branchId } : {}),
});

export async function openSurvey(ctx: TenantContext, surveyId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await managedSurvey(tx, ctx, surveyId);
    if (s.status !== "DRAFT")
      throw businessRuleViolation("SURVEY_NOT_DRAFT", "The survey is no longer a draft");
    if (s.questions.length === 0)
      throw businessRuleViolation("SURVEY_NO_QUESTIONS", "Add at least one question");
    if (s.closesOn && s.closesOn.toISOString().slice(0, 10) < businessDate(ctx.timeZone))
      throw businessRuleViolation("SURVEY_CLOSES_IN_PAST", "The closing day has passed");
    const audienceCount = await tx.employee.count({ where: audienceWhere(ctx, s.branchId) });
    await tx.engagementSurvey.update({
      where: { id: s.id },
      data: { status: "OPEN", openedAt: new Date(), audienceCount },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "engagement_survey.opened",
      entityType: "engagement_survey",
      entityId: s.id,
      changes: { audienceCount },
    });
    return { audienceCount };
  });
}

export async function closeSurvey(ctx: TenantContext, surveyId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await managedSurvey(tx, ctx, surveyId);
    if (s.status !== "OPEN")
      throw businessRuleViolation("SURVEY_NOT_OPEN", "The survey is not open");
    await tx.engagementSurvey.update({
      where: { id: s.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "engagement_survey.closed",
      entityType: "engagement_survey",
      entityId: s.id,
    });
  });
}

export async function listSurveys(ctx: TenantContext) {
  if (!canViewEngagement(ctx)) throw forbidden();
  const branches = viewBranches(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => ({
    surveys: await tx.engagementSurvey.findMany({
      where: {
        organizationId: ctx.organizationId,
        // Branch viewers see their branch's surveys and the all-branch ones.
        ...(branches ? { OR: [{ branchId: null }, { branchId: { in: branches } }] } : {}),
      },
      include: { _count: { select: { responses: true, questions: true } } },
      orderBy: { createdAt: "desc" },
    }),
    branches: await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(branches ? { id: { in: branches } } : {}),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    canManage: holdsAnyGrant(ctx.grants, "engagement.manage"),
  }));
}

// ─── Answering (staff) ───

const isOpenForAnswers = (s: { status: string; closesOn: Date | null }, today: string) =>
  s.status === "OPEN" && (!s.closesOn || s.closesOn.toISOString().slice(0, 10) >= today);

export async function surveysToAnswer(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const self = await me(tx, ctx);
    if (!self) return [];
    const today = businessDate(ctx.timeZone);
    const open = await tx.engagementSurvey.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "OPEN",
        OR: [{ branchId: null }, { branchId: self.branchId }],
        participations: { none: { employeeId: self.id } },
      },
      select: { id: true, title: true, intro: true, closesOn: true, status: true },
      orderBy: { openedAt: "asc" },
    });
    return open.filter((s) => isOpenForAnswers(s, today));
  });
}

export async function surveyToAnswer(ctx: TenantContext, surveyId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const self = await me(tx, ctx);
    const s = await loadSurvey(tx, ctx, surveyId);
    if (!self || (s.branchId && s.branchId !== self.branchId) || s.status === "DRAFT")
      throw notFound("Survey");
    const answered = await tx.engagementParticipation.findUnique({
      where: {
        organizationId_surveyId_employeeId: {
          organizationId: ctx.organizationId,
          surveyId: s.id,
          employeeId: self.id,
        },
      },
    });
    return {
      survey: { id: s.id, title: s.title, intro: s.intro, closesOn: s.closesOn },
      questions: s.questions.map((q) => ({
        id: q.id,
        type: q.type as QuestionType,
        text: q.text,
        required: q.required,
      })),
      answered: !!answered,
      open: isOpenForAnswers(s, businessDate(ctx.timeZone)),
    };
  });
}

/**
 * Submit answers sent as `q.<questionId>`. The participation row (who) and
 * the response (what) are written together but never point at each other.
 */
export async function submitSurvey(ctx: TenantContext, surveyId: string, rawInput: unknown) {
  const raw = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const self = await me(tx, ctx);
    const s = await loadSurvey(tx, ctx, surveyId);
    if (!self || (s.branchId && s.branchId !== self.branchId) || s.status === "DRAFT")
      throw notFound("Survey");
    const today = businessDate(ctx.timeZone);
    if (!isOpenForAnswers(s, today))
      throw businessRuleViolation("SURVEY_NOT_OPEN", "The survey is not open");
    const answers: Array<{ questionId: string; value: number | null; text: string | null }> = [];
    for (const q of s.questions) {
      const v = raw[`q.${q.id}`];
      const given = typeof v === "string" && v.trim() !== "";
      if (!given) {
        if (q.required)
          throw businessRuleViolation("SURVEY_ANSWER_REQUIRED", "Answer every required question", {
            field: `q.${q.id}`,
          });
        continue;
      }
      const text = q.type === "TEXT" ? (v as string).trim() : null;
      const value = q.type === "TEXT" ? null : Number(v);
      if (!validAnswer(q.type as QuestionType, value, text))
        throw businessRuleViolation("SURVEY_ANSWER_INVALID", "An answer is not valid", {
          field: `q.${q.id}`,
        });
      answers.push({ questionId: q.id, value, text });
    }
    try {
      await tx.engagementParticipation.create({
        data: { organizationId: ctx.organizationId, surveyId: s.id, employeeId: self.id },
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002")
        throw conflict("You have already answered this survey");
      throw error;
    }
    const response = await tx.engagementResponse.create({
      data: {
        organizationId: ctx.organizationId,
        surveyId: s.id,
        branchId: self.branchId,
        submittedOn: asDate(today),
      },
      select: { id: true },
    });
    if (answers.length)
      await tx.engagementAnswer.createMany({
        data: answers.map((a) => ({
          organizationId: ctx.organizationId,
          responseId: response.id,
          ...a,
        })),
      });
    // Deliberately no audit event: it would tie a person and a time to the answers.
  });
}

// ─── Results ───

export async function surveyResults(ctx: TenantContext, surveyId: string) {
  if (!canViewEngagement(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadSurvey(tx, ctx, surveyId);
    const branches = viewBranches(ctx);
    if (branches && s.branchId && !branches.includes(s.branchId)) throw notFound("Survey");
    // Branch-scoped viewers of an all-branch survey see only their branches' answers.
    const responseWhere = {
      organizationId: ctx.organizationId,
      surveyId: s.id,
      ...(branches ? { branchId: { in: branches } } : {}),
    };
    const [responses, answers, branchRows] = await inSequence([
      tx.engagementResponse.findMany({
        where: responseWhere,
        select: { id: true, branchId: true },
      }),
      tx.engagementAnswer.findMany({
        where: { organizationId: ctx.organizationId, response: responseWhere },
        select: {
          id: true,
          questionId: true,
          value: true,
          text: true,
          response: { select: { branchId: true } },
        },
      }),
      tx.branch.findMany({
        where: { organizationId: ctx.organizationId },
        select: { id: true, code: true, name: true },
      }),
    ]);
    const shown = mayShow(responses.length);
    const perBranch = new Map<string, number>();
    for (const r of responses) perBranch.set(r.branchId, (perBranch.get(r.branchId) ?? 0) + 1);
    const branchName = new Map(branchRows.map((b) => [b.id, `${b.code} — ${b.name}`]));
    const questions = s.questions.map((q) => {
      const mine = answers.filter((a) => a.questionId === q.id);
      if (!shown)
        return { id: q.id, type: q.type as QuestionType, text: q.text, answers: mine.length };
      const values = mine.map((a) => a.value).filter((v): v is number => v !== null);
      // Branch breakdowns only for branches with enough answers.
      const byBranch = [...perBranch]
        .filter(([, n]) => mayShow(n))
        .map(([branchId]) => {
          const vs = mine
            .filter((a) => a.response.branchId === branchId)
            .map((a) => a.value!)
            .filter((v) => v !== null);
          return {
            branch: branchName.get(branchId) ?? "—",
            rating: q.type === "RATING" ? ratingSummary(vs).average : null,
            enps: q.type === "ENPS" ? enps(vs).score : null,
          };
        });
      return {
        id: q.id,
        type: q.type as QuestionType,
        text: q.text,
        answers: mine.length,
        rating: q.type === "RATING" ? ratingSummary(values) : null,
        enps: q.type === "ENPS" ? enps(values) : null,
        yesShare:
          q.type === "YES_NO" && values.length
            ? values.filter((v) => v === 1).length / values.length
            : null,
        texts:
          q.type === "TEXT"
            ? shuffled(
                mine.filter((a) => a.text),
                s.id,
              ).map((a) => a.text as string)
            : null,
        byBranch: q.type === "RATING" || q.type === "ENPS" ? byBranch : [],
      };
    });
    return {
      survey: s,
      responses: responses.length,
      responseRate: s.audienceCount ? responses.length / s.audienceCount : null,
      shown,
      minimum: ANONYMITY_MIN,
      questions,
      canManage: manageAt(ctx, s.branchId),
    };
  });
}

// ─── Recognition ───

export async function giveRecognition(ctx: TenantContext, rawInput: unknown) {
  const parsed = z
    .object({
      toEmployeeId: uuidSchema,
      value: z.enum(RECOGNITION_VALUES, { error: "invalidOption" }),
      message: requiredText(500),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const self = await me(tx, ctx);
    if (!self)
      throw businessRuleViolation(
        "ATTENDANCE_NOT_EMPLOYEE",
        "Your account is not linked to an employee",
      );
    if (self.id === parsed.data.toEmployeeId)
      throw businessRuleViolation("RECOGNITION_SELF", "Recognize a colleague, not yourself", {
        field: "toEmployeeId",
      });
    const to = await tx.employee.findFirst({
      where: {
        organizationId: ctx.organizationId,
        id: parsed.data.toEmployeeId,
        status: { not: "TERMINATED" },
      },
      select: { id: true },
    });
    if (!to) throw notFound("Employee");
    return tx.recognition.create({
      data: {
        organizationId: ctx.organizationId,
        fromEmployeeId: self.id,
        toEmployeeId: to.id,
        value: parsed.data.value,
        message: parsed.data.message,
      },
      select: { id: true },
    });
  });
}

/** The wall: staff and those who see engagement; hidden posts only for those who manage. */
export async function recognitionWall(ctx: TenantContext, options: { employeeId?: string } = {}) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const self = await me(tx, ctx);
    if (!self && !canViewEngagement(ctx)) throw forbidden();
    const manager = holdsAnyGrant(ctx.grants, "engagement.manage");
    const [posts, colleagues] = await inSequence([
      tx.recognition.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(manager ? {} : { hiddenAt: null }),
          ...(options.employeeId ? { toEmployeeId: options.employeeId } : {}),
        },
        include: {
          from: { select: { firstName: true, lastName: true } },
          to: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              jobTitle: true,
              branchId: true,
              branch: { select: { code: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      self
        ? tx.employee.findMany({
            where: {
              organizationId: ctx.organizationId,
              status: { not: "TERMINATED" },
              id: { not: self.id },
            },
            select: {
              id: true,
              number: true,
              firstName: true,
              lastName: true,
              branch: { select: { code: true } },
            },
            orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
          })
        : Promise.resolve([]),
    ]);
    return {
      posts: posts.map((p) => ({ ...p, canHide: !p.hiddenAt && manageAt(ctx, p.to.branchId) })),
      colleagues,
      canGive: !!self,
    };
  });
}

export async function hideRecognition(
  ctx: TenantContext,
  recognitionId: string,
  rawInput: unknown,
) {
  const parsed = z.object({ reason: requiredText(200) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const r = await tx.recognition.findFirst({
      where: { organizationId: ctx.organizationId, id: recognitionId },
      include: { to: { select: { branchId: true } } },
    });
    if (!r) throw notFound("Recognition");
    if (!manageAt(ctx, r.to.branchId)) throw forbidden();
    if (r.hiddenAt) throw businessRuleViolation("RECOGNITION_HIDDEN", "Already hidden");
    await tx.recognition.update({
      where: { id: r.id },
      data: { hiddenAt: new Date(), hiddenByUserId: ctx.userId, hiddenReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "recognition.hidden",
      entityType: "recognition",
      entityId: r.id,
      changes: { reason: parsed.data.reason },
    });
  });
}

/** Surveys waiting for this person (Needs attention), inside an open transaction. */
export async function surveysToAnswerCountInTx(tx: Tx, ctx: TenantContext) {
  const self = await me(tx, ctx);
  if (!self) return 0;
  const today = businessDate(ctx.timeZone);
  const open = await tx.engagementSurvey.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: "OPEN",
      OR: [{ branchId: null }, { branchId: self.branchId }],
      participations: { none: { employeeId: self.id } },
    },
    select: { status: true, closesOn: true },
  });
  return open.filter((s) => isOpenForAnswers(s, today)).length;
}
