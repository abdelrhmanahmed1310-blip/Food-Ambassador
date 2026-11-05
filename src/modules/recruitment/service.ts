import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { createEmployeeInTx, employeeUniqueError } from "@/modules/hr/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { zonedInstant } from "@/modules/pos/pickup-rules";
import { startOnboardingInTx } from "@/modules/rosters/onboarding";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  ACTIVE_STAGES,
  allowedMoves,
  CANDIDATE_SOURCES,
  erasureDue,
  INTERVIEW_KINDS,
  RECOMMENDATIONS,
  scorecardSummary,
  titleKey,
  workforceRows,
  type Stage,
} from "./rules";

/**
 * Recruitment and workforce planning (DECISIONS.md ADR-129): a planned
 * headcount per branch and job title; openings requested by a branch and
 * approved by organization-wide HR (not the requester); candidates moving
 * through stages with interviews and scorecards; a hire creates the
 * employee (and may start onboarding) in one step. Candidates are personal
 * data: erased by hand or after the retention days the organization sets.
 */

const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const date = z.string().refine(isCalendarDate, { error: "invalidDate" });
const blank = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null);

// ─── Access ───

const VIEW_PERMS = ["recruitment.view", "recruitment.manage", "hr.manage"] as const;

export function canViewRecruitment(ctx: TenantContext) {
  return VIEW_PERMS.some((p) => holdsAnyGrant(ctx.grants, p));
}
const canManageAny = (ctx: TenantContext) =>
  holdsAnyGrant(ctx.grants, "recruitment.manage") || holdsAnyGrant(ctx.grants, "hr.manage");
const mayManageAt = (ctx: TenantContext, branchId: string) =>
  hasPermission(ctx.grants, "recruitment.manage", { branchId }) ||
  hasPermission(ctx.grants, "hr.manage", { branchId });
/** Organization-wide HR approves openings, sets retention and erases candidates. */
export const isOrgHr = (ctx: TenantContext) => accessibleScope(ctx.grants, "hr.manage").all;

/** Branches the user sees recruitment for; null is all. */
function branchIds(ctx: TenantContext): string[] | null {
  const scopes = VIEW_PERMS.map((p) => accessibleScope(ctx.grants, p));
  const ids: string[] = [];
  for (const s of scopes) {
    if (s.all) return null;
    ids.push(...s.branchIds);
  }
  return [...new Set(ids)];
}
const openingWhere = (ctx: TenantContext): Prisma.JobOpeningWhereInput => {
  const ids = branchIds(ctx);
  return { organizationId: ctx.organizationId, ...(ids ? { branchId: { in: ids } } : {}) };
};
/** Candidates the user may see: all for organization-wide viewers, else those on their openings or added by them. */
const candidateWhere = (ctx: TenantContext): Prisma.CandidateWhereInput => {
  const ids = branchIds(ctx);
  return {
    organizationId: ctx.organizationId,
    ...(ids
      ? {
          OR: [
            { createdByUserId: ctx.userId },
            { applications: { some: { opening: { branchId: { in: ids } } } } },
          ],
        }
      : {}),
  };
};

// ─── Settings ───

export async function getRecruitmentSettings(ctx: TenantContext) {
  if (!canViewRecruitment(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.recruitmentSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
  );
}

export async function setRecruitmentSettings(ctx: TenantContext, rawInput: unknown) {
  if (!isOrgHr(ctx)) throw forbidden();
  const parsed = z
    .object({
      candidateRetentionDays: blank.pipe(
        z
          .string()
          .regex(/^\d{1,4}$/, { error: "invalidNumber" })
          .transform(Number)
          .refine((n) => n >= 30 && n <= 3650, { error: "retentionRange" })
          .nullable(),
      ),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const days = parsed.data.candidateRetentionDays;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const data = { candidateRetentionDays: days, updatedByUserId: ctx.userId };
    await tx.recruitmentSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "recruitment.settings_changed",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { candidateRetentionDays: days },
    });
  });
}

// ─── Workforce plan ───

const positionSchema = z.object({
  branchId: uuidSchema,
  jobTitle: requiredText(120),
  plannedHeadcount: z.coerce.number({ error: "invalidNumber" }).int().min(0).max(10000),
  note: optionalText(200),
});

/** Set the planned headcount of a job title at a branch (0 plans none). */
export async function setPosition(ctx: TenantContext, rawInput: unknown) {
  const parsed = positionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (!hasPermission(ctx.grants, "hr.manage", { branchId: v.branchId })) throw forbidden();
  await withTenantTx(ctx.organizationId, async (tx) => {
    await loadBranch(tx, ctx, v.branchId);
    const key = titleKey(v.jobTitle);
    const data = {
      jobTitle: v.jobTitle.replace(/\s+/g, " "),
      plannedHeadcount: v.plannedHeadcount,
      note: v.note ?? null,
      updatedByUserId: ctx.userId,
    };
    await tx.workforcePosition.upsert({
      where: {
        organizationId_branchId_titleKey: {
          organizationId: ctx.organizationId,
          branchId: v.branchId,
          titleKey: key,
        },
      },
      create: { organizationId: ctx.organizationId, branchId: v.branchId, titleKey: key, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "workforce.position_set",
      entityType: "branch",
      entityId: v.branchId,
      changes: { jobTitle: data.jobTitle, plannedHeadcount: v.plannedHeadcount },
    });
  });
}

async function loadBranch(tx: Tx, ctx: TenantContext, branchId: string) {
  const b = await tx.branch.findFirst({
    where: { organizationId: ctx.organizationId, id: branchId, archivedAt: null },
    select: { id: true, code: true, name: true, timeZone: true },
  });
  if (!b) throw notFound("Branch");
  return b;
}

const LIVE_OPENING = ["PENDING_APPROVAL", "OPEN"] as const;

async function planRowsInTx(tx: Tx, ctx: TenantContext, branchIds: string[] | null) {
  const where = branchIds ? { branchId: { in: branchIds } } : {};
  const [positions, employees, openings] = await Promise.all([
    tx.workforcePosition.findMany({
      where: { organizationId: ctx.organizationId, ...where },
      select: { branchId: true, jobTitle: true, plannedHeadcount: true },
    }),
    tx.employee.findMany({
      where: { organizationId: ctx.organizationId, status: { not: "TERMINATED" }, ...where },
      select: { branchId: true, jobTitle: true },
    }),
    tx.jobOpening.findMany({
      where: { organizationId: ctx.organizationId, status: { in: [...LIVE_OPENING] }, ...where },
      select: { branchId: true, jobTitle: true, headcount: true, hired: true },
    }),
  ]);
  return workforceRows({
    positions: positions.map((p) => ({ ...p, planned: p.plannedHeadcount })),
    employees,
    openings: openings.map((o) => ({ ...o, remaining: o.headcount - o.hired })),
  });
}

/** The plan against people in post and openings, for the branches the user sees. */
export async function workforcePlan(ctx: TenantContext) {
  const hrIds = (() => {
    const v = accessibleScope(ctx.grants, "hr.view");
    const m = accessibleScope(ctx.grants, "hr.manage");
    if (v.all || m.all) return null;
    return [...v.branchIds, ...m.branchIds];
  })();
  if (hrIds && hrIds.length === 0 && !canViewRecruitment(ctx)) throw forbidden();
  const ids = hrIds ?? null;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branches = await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });
    const rows = await planRowsInTx(tx, ctx, ids);
    return {
      branches,
      rows,
      can: {
        plan: branches.filter((b) => hasPermission(ctx.grants, "hr.manage", { branchId: b.id })),
      },
    };
  });
}

// ─── Openings ───

const openingSchema = z.object({
  branchId: uuidSchema,
  departmentId: blank.pipe(uuidSchema.nullable()),
  jobTitle: requiredText(120),
  employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "TEMPORARY"], {
    error: "invalidOption",
  }),
  headcount: z.coerce.number({ error: "invalidNumber" }).int().min(1).max(500),
  reason: z.enum(["NEW_POSITION", "REPLACEMENT", "SEASONAL"], { error: "invalidOption" }),
  description: optionalText(2000),
  targetStartOn: blank.refine((v) => v === null || isCalendarDate(v), { error: "invalidDate" }),
});

/** Ask to recruit: the places beyond the plan are recorded for the approver. */
export async function requestOpening(ctx: TenantContext, rawInput: unknown) {
  const parsed = openingSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (!mayManageAt(ctx, v.branchId)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    await loadBranch(tx, ctx, v.branchId);
    if (v.departmentId) {
      const d = await tx.department.findFirst({
        where: { organizationId: ctx.organizationId, id: v.departmentId },
        select: { id: true },
      });
      if (!d) throw notFound("Department");
    }
    const key = titleKey(v.jobTitle);
    const row = (await planRowsInTx(tx, ctx, [v.branchId])).find(
      (r) => titleKey(r.jobTitle) === key,
    );
    const room = Math.max(0, row?.gap ?? 0);
    const o = await tx.jobOpening.create({
      data: {
        organizationId: ctx.organizationId,
        number: await nextDocumentNumber(
          tx,
          ctx.organizationId,
          "JOB",
          new Date().getUTCFullYear(),
        ),
        branchId: v.branchId,
        departmentId: v.departmentId,
        jobTitle: v.jobTitle.replace(/\s+/g, " "),
        titleKey: key,
        employmentType: v.employmentType,
        headcount: v.headcount,
        reason: v.reason,
        description: v.description ?? null,
        targetStartOn: v.targetStartOn ? asDate(v.targetStartOn) : null,
        beyondPlan: Math.max(0, v.headcount - room),
        requestedByUserId: ctx.userId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "job_opening.requested",
      entityType: "job_opening",
      entityId: o.id,
      changes: {
        number: o.number,
        jobTitle: o.jobTitle,
        headcount: o.headcount,
        beyondPlan: o.beyondPlan,
      },
    });
    return o;
  });
}

async function loadOpening(tx: Tx, ctx: TenantContext, openingId: string) {
  const id = uuidSchema.safeParse(openingId);
  if (!id.success) throw notFound("Opening");
  const o = await tx.jobOpening.findFirst({ where: { ...openingWhere(ctx), id: id.data } });
  if (!o) throw notFound("Opening");
  return o;
}

export async function decideOpening(ctx: TenantContext, openingId: string, rawInput: unknown) {
  const parsed = z
    .object({
      decision: z.enum(["APPROVE", "REJECT"], { error: "invalidOption" }),
      note: optionalText(300),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  if (!isOrgHr(ctx)) throw forbidden();
  await withTenantTx(ctx.organizationId, async (tx) => {
    const o = await loadOpening(tx, ctx, openingId);
    if (o.status !== "PENDING_APPROVAL")
      throw businessRuleViolation("OPENING_NOT_PENDING", "This opening was already decided");
    if (o.requestedByUserId === ctx.userId)
      throw businessRuleViolation("OPENING_SELF_APPROVAL", "Someone else approves your request");
    const approve = parsed.data.decision === "APPROVE";
    await tx.jobOpening.update({
      where: { id: o.id },
      data: {
        status: approve ? "OPEN" : "REJECTED",
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: parsed.data.note ?? null,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: approve ? "job_opening.approved" : "job_opening.rejected",
      entityType: "job_opening",
      entityId: o.id,
      changes: { note: parsed.data.note ?? null },
    });
  });
}

/** Close an opening that is no longer recruited for; candidates still in play are closed first. */
export async function closeOpening(ctx: TenantContext, openingId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(200) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const o = await loadOpening(tx, ctx, openingId);
    if (!mayManageAt(ctx, o.branchId)) throw forbidden();
    if (o.status !== "OPEN")
      throw businessRuleViolation("OPENING_NOT_OPEN", "Only an open opening is closed");
    const active = await tx.jobApplication.count({
      where: {
        organizationId: ctx.organizationId,
        openingId: o.id,
        stage: { in: [...ACTIVE_STAGES] },
      },
    });
    if (active)
      throw businessRuleViolation(
        "OPENING_HAS_CANDIDATES",
        "Reject or withdraw the candidates still in play first",
      );
    await tx.jobOpening.update({
      where: { id: o.id },
      data: { status: "CLOSED", closedAt: new Date(), closeReason: parsed.data.reason },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "job_opening.closed",
      entityType: "job_opening",
      entityId: o.id,
      changes: { reason: parsed.data.reason },
    });
  });
}

export async function listOpenings(ctx: TenantContext, rawStatus?: unknown) {
  if (!canViewRecruitment(ctx)) throw forbidden();
  const status = z
    .enum(["PENDING_APPROVAL", "OPEN", "FILLED", "CLOSED", "REJECTED"])
    .safeParse(rawStatus);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const openings = await tx.jobOpening.findMany({
      where: {
        ...openingWhere(ctx),
        ...(status.success ? { status: status.data } : { status: { in: [...LIVE_OPENING] } }),
      },
      include: {
        branch: { select: { code: true, name: true } },
        applications: { select: { stage: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const ids = branchIds(ctx);
    const branches = await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });
    const departments = await tx.department.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return {
      openings: openings.map(({ applications, ...o }) => ({
        ...o,
        active: applications.filter((a) => ACTIVE_STAGES.includes(a.stage as Stage)).length,
      })),
      branches: branches.filter((b) => mayManageAt(ctx, b.id)),
      departments,
      can: { request: canManageAny(ctx), approve: isOrgHr(ctx) },
    };
  });
}

export async function getOpening(ctx: TenantContext, openingId: string) {
  if (!canViewRecruitment(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const o = await loadOpening(tx, ctx, openingId);
    const [branch, applications, candidates] = await Promise.all([
      loadBranch(tx, ctx, o.branchId),
      tx.jobApplication.findMany({
        where: { organizationId: ctx.organizationId, openingId: o.id },
        include: {
          candidate: {
            select: { id: true, firstName: true, lastName: true, erasedAt: true, source: true },
          },
          interviews: { select: { rating: true, recommendation: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      tx.candidate.findMany({
        where: { ...candidateWhere(ctx), erasedAt: null },
        select: { id: true, firstName: true, lastName: true, email: true },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        take: 500,
      }),
    ]);
    const manage = mayManageAt(ctx, o.branchId);
    const onIt = new Set(applications.map((a) => a.candidateId));
    return {
      opening: o,
      branch,
      applications: applications.map(({ interviews, ...a }) => ({
        ...a,
        scorecards: scorecardSummary(interviews),
      })),
      candidates: candidates.filter((c) => !onIt.has(c.id)),
      can: {
        manage: manage && o.status === "OPEN",
        decide:
          isOrgHr(ctx) && o.status === "PENDING_APPROVAL" && o.requestedByUserId !== ctx.userId,
        close: manage && o.status === "OPEN",
      },
    };
  });
}

// ─── Candidates ───

const candidateSchema = z.object({
  firstName: requiredText(80),
  lastName: requiredText(80),
  email: z
    .union([z.literal(""), z.email({ error: "invalidEmail" })])
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null)),
  phone: z
    .string()
    .trim()
    .max(30, { error: "tooLong" })
    .regex(/^[+0-9 ()-]*$/, { error: "invalid" })
    .optional()
    .transform((v) => v || null),
  source: z.enum(CANDIDATE_SOURCES, { error: "invalidOption" }),
  note: optionalText(1000),
});

async function createCandidateInTx(tx: Tx, ctx: TenantContext, rawInput: unknown) {
  const parsed = candidateSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (v.email) {
    const same = await tx.candidate.findFirst({
      where: {
        organizationId: ctx.organizationId,
        erasedAt: null,
        email: { equals: v.email, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (same) throw conflict("A candidate with this e-mail already exists", { field: "email" });
  }
  const c = await tx.candidate.create({
    data: {
      organizationId: ctx.organizationId,
      ...v,
      note: v.note ?? null,
      createdByUserId: ctx.userId,
    },
  });
  // Names and contact details are personal data: not written to the audit log.
  await recordAudit(tx, actorOf(ctx), {
    action: "candidate.created",
    entityType: "candidate",
    entityId: c.id,
    changes: { source: v.source },
  });
  return c;
}

export async function createCandidate(ctx: TenantContext, rawInput: unknown) {
  if (!canManageAny(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, (tx) => createCandidateInTx(tx, ctx, rawInput));
}

/** Put a candidate (existing, or new from the form) on an open opening. */
export async function addApplication(ctx: TenantContext, openingId: string, rawInput: unknown) {
  const raw = (rawInput ?? {}) as Record<string, unknown>;
  const existing = typeof raw.candidateId === "string" && raw.candidateId ? raw.candidateId : null;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const o = await loadOpening(tx, ctx, openingId);
    if (!mayManageAt(ctx, o.branchId)) throw forbidden();
    if (o.status !== "OPEN")
      throw businessRuleViolation("OPENING_NOT_OPEN", "This opening is not open for candidates");
    let candidateId: string;
    if (existing) {
      const id = uuidSchema.safeParse(existing);
      const c = id.success
        ? await tx.candidate.findFirst({ where: { ...candidateWhere(ctx), id: id.data } })
        : null;
      if (!c) throw notFound("Candidate");
      if (c.erasedAt) throw businessRuleViolation("CANDIDATE_ERASED", "This candidate was erased");
      candidateId = c.id;
    } else {
      candidateId = (await createCandidateInTx(tx, ctx, raw)).id;
    }
    const dup = await tx.jobApplication.findFirst({
      where: { organizationId: ctx.organizationId, openingId: o.id, candidateId },
      select: { id: true },
    });
    if (dup) throw conflict("This candidate is already on this opening");
    const a = await tx.jobApplication.create({
      data: { organizationId: ctx.organizationId, openingId: o.id, candidateId },
    });
    await tx.applicationEvent.create({
      data: {
        organizationId: ctx.organizationId,
        applicationId: a.id,
        toStage: "APPLIED",
        byUserId: ctx.userId,
      },
    });
    await touch(tx, candidateId);
    return a;
  });
}

const touch = (tx: Tx, candidateId: string) =>
  tx.candidate.update({ where: { id: candidateId }, data: { lastActivityAt: new Date() } });

export async function listCandidates(ctx: TenantContext, rawQuery?: unknown) {
  if (!canViewRecruitment(ctx)) throw forbidden();
  const q = z
    .string()
    .trim()
    .max(80)
    .catch("")
    .parse(rawQuery ?? "");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.candidate.findMany({
      where: {
        ...candidateWhere(ctx),
        ...(q
          ? {
              OR: [
                { firstName: { contains: q, mode: "insensitive" } },
                { lastName: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        applications: {
          select: { stage: true, opening: { select: { number: true, jobTitle: true } } },
        },
      },
      orderBy: { lastActivityAt: "desc" },
      take: 200,
    }),
  );
}

export async function getCandidate(ctx: TenantContext, candidateId: string) {
  if (!canViewRecruitment(ctx)) throw forbidden();
  const id = uuidSchema.safeParse(candidateId);
  if (!id.success) throw notFound("Candidate");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.candidate.findFirst({
      where: { ...candidateWhere(ctx), id: id.data },
      include: {
        applications: {
          include: {
            opening: {
              select: {
                id: true,
                number: true,
                jobTitle: true,
                branch: { select: { code: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!c) throw notFound("Candidate");
    return {
      candidate: c,
      can: {
        erase:
          isOrgHr(ctx) &&
          !c.erasedAt &&
          !c.applications.some((a) => ACTIVE_STAGES.includes(a.stage as Stage)),
      },
    };
  });
}

/** Erase a candidate's personal data: names, contact, notes, CVs; the record stays for counts. */
async function eraseInTx(tx: Tx, organizationId: string, candidateId: string) {
  await tx.candidate.update({
    where: { id: candidateId },
    data: {
      firstName: "—",
      lastName: "—",
      email: null,
      phone: null,
      note: null,
      erasedAt: new Date(),
    },
  });
  const apps = await tx.jobApplication.findMany({
    where: { organizationId, candidateId },
    select: { id: true },
  });
  await tx.jobApplication.updateMany({
    where: { organizationId, candidateId },
    data: { closeNote: null },
  });
  await tx.interview.updateMany({
    where: { organizationId, applicationId: { in: apps.map((a) => a.id) } },
    data: { notes: null, location: null },
  });
  const files = await tx.attachment.findMany({
    where: { organizationId, entityType: "CANDIDATE", entityId: candidateId, purgedAt: null },
    select: { id: true },
  });
  for (const f of files) {
    await tx.attachmentContent.deleteMany({ where: { attachmentId: f.id } });
    await tx.attachment.update({ where: { id: f.id }, data: { purgedAt: new Date() } });
  }
}

export async function eraseCandidate(ctx: TenantContext, candidateId: string) {
  if (!isOrgHr(ctx)) throw forbidden();
  const id = uuidSchema.safeParse(candidateId);
  if (!id.success) throw notFound("Candidate");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.candidate.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
      include: { applications: { select: { stage: true } } },
    });
    if (!c) throw notFound("Candidate");
    if (c.erasedAt) return;
    if (c.applications.some((a) => ACTIVE_STAGES.includes(a.stage as Stage)))
      throw businessRuleViolation(
        "CANDIDATE_ACTIVE",
        "Reject or withdraw the candidate's open applications first",
      );
    await eraseInTx(tx, ctx.organizationId, c.id);
    await recordAudit(tx, actorOf(ctx), {
      action: "candidate.erased",
      entityType: "candidate",
      entityId: c.id,
      changes: {},
    });
  });
}

/** The daily job: erase candidates past each organization's retention days (ADR-129). */
export async function purgeCandidates(now = new Date()) {
  return withSystemTx(async (tx) => {
    const settings = await tx.recruitmentSettings.findMany({
      where: { candidateRetentionDays: { not: null } },
    });
    let erased = 0;
    for (const s of settings) {
      const before = new Date(now.getTime() - s.candidateRetentionDays! * 86_400_000);
      const due = await tx.candidate.findMany({
        where: { organizationId: s.organizationId, erasedAt: null, lastActivityAt: { lt: before } },
        include: { applications: { select: { stage: true } } },
        take: 500,
      });
      for (const c of due) {
        if (
          !erasureDue({
            stages: c.applications.map((a) => a.stage as Stage),
            lastActivityAt: c.lastActivityAt,
            retentionDays: s.candidateRetentionDays,
            now,
          })
        )
          continue;
        await eraseInTx(tx, s.organizationId, c.id);
        erased++;
      }
    }
    return { erased };
  });
}

// ─── Applications ───

async function loadApplication(tx: Tx, ctx: TenantContext, applicationId: string) {
  const id = uuidSchema.safeParse(applicationId);
  if (!id.success) throw notFound("Application");
  const a = await tx.jobApplication.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data, opening: openingWhere(ctx) },
    include: { opening: true, candidate: true },
  });
  if (!a) throw notFound("Application");
  return a;
}

export async function moveApplication(
  ctx: TenantContext,
  applicationId: string,
  rawInput: unknown,
) {
  const parsed = z
    .object({
      to: z.enum(["SCREENING", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"], {
        error: "invalidOption",
      }),
      note: optionalText(300),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { to, note } = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const a = await loadApplication(tx, ctx, applicationId);
    if (!mayManageAt(ctx, a.opening.branchId)) throw forbidden();
    if (!allowedMoves(a.stage as Stage).includes(to))
      throw businessRuleViolation("APPLICATION_MOVE", "The application cannot move to this stage");
    await moveInTx(tx, ctx, a.id, a.stage as Stage, to, note ?? null);
    await touch(tx, a.candidateId);
  });
}

async function moveInTx(
  tx: Tx,
  ctx: TenantContext,
  applicationId: string,
  from: Stage,
  to: Stage,
  note: string | null,
  extra: Prisma.JobApplicationUncheckedUpdateInput = {},
) {
  await tx.jobApplication.update({
    where: { id: applicationId },
    data: {
      stage: to,
      stageChangedAt: new Date(),
      ...(to === "REJECTED" || to === "WITHDRAWN" ? { closeNote: note } : {}),
      ...extra,
    },
  });
  await tx.applicationEvent.create({
    data: {
      organizationId: ctx.organizationId,
      applicationId,
      fromStage: from,
      toStage: to,
      note,
      byUserId: ctx.userId,
    },
  });
}

async function membersInTx(tx: Tx, ctx: TenantContext) {
  const m = await tx.organizationMembership.findMany({
    where: { organizationId: ctx.organizationId, status: "ACTIVE" },
    select: { user: { select: { id: true, name: true } } },
    orderBy: { joinedAt: "asc" },
  });
  return m.map((x) => x.user);
}

export async function getApplication(ctx: TenantContext, applicationId: string) {
  if (!canViewRecruitment(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const a = await loadApplication(tx, ctx, applicationId);
    const [branch, events, interviews, members, templates, managers] = await Promise.all([
      loadBranch(tx, ctx, a.opening.branchId),
      tx.applicationEvent.findMany({
        where: { organizationId: ctx.organizationId, applicationId: a.id },
        orderBy: { at: "asc" },
      }),
      tx.interview.findMany({
        where: { organizationId: ctx.organizationId, applicationId: a.id },
        include: { interviewer: { select: { name: true } } },
        orderBy: { scheduledAt: "asc" },
      }),
      membersInTx(tx, ctx),
      tx.onboardingTemplate.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null, tasks: { some: {} } },
        select: { id: true, name: true },
        orderBy: { code: "asc" },
      }),
      tx.employee.findMany({
        where: {
          organizationId: ctx.organizationId,
          branchId: a.opening.branchId,
          status: { not: "TERMINATED" },
        },
        select: { id: true, firstName: true, lastName: true, jobTitle: true },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      }),
    ]);
    const manage = mayManageAt(ctx, a.opening.branchId);
    const stage = a.stage as Stage;
    return {
      application: a,
      branch,
      events,
      interviews,
      scorecards: scorecardSummary(interviews),
      members,
      templates,
      managers,
      can: {
        moves: manage ? allowedMoves(stage) : [],
        schedule: manage && (stage === "SCREENING" || stage === "INTERVIEW"),
        hire:
          stage === "OFFER" &&
          a.opening.status === "OPEN" &&
          hasPermission(ctx.grants, "hr.manage", { branchId: a.opening.branchId }),
        manage,
      },
    };
  });
}

// ─── Interviews ───

const interviewSchema = z.object({
  kind: z.enum(INTERVIEW_KINDS, { error: "invalidOption" }),
  date,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "invalidTime" }),
  interviewerUserId: uuidSchema,
  location: optionalText(200),
});

/** Schedule an interview or trial shift; a screened candidate moves to the interview stage. */
export async function scheduleInterview(
  ctx: TenantContext,
  applicationId: string,
  rawInput: unknown,
) {
  const parsed = interviewSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const a = await loadApplication(tx, ctx, applicationId);
    if (!mayManageAt(ctx, a.opening.branchId)) throw forbidden();
    if (a.stage !== "SCREENING" && a.stage !== "INTERVIEW")
      throw businessRuleViolation(
        "INTERVIEW_STAGE",
        "Interviews are scheduled while screening or interviewing",
      );
    const member = await tx.organizationMembership.findFirst({
      where: { organizationId: ctx.organizationId, userId: v.interviewerUserId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!member)
      throw businessRuleViolation("INTERVIEWER_NOT_MEMBER", "Choose a member of the organization", {
        field: "interviewerUserId",
      });
    const branch = await loadBranch(tx, ctx, a.opening.branchId);
    const i = await tx.interview.create({
      data: {
        organizationId: ctx.organizationId,
        applicationId: a.id,
        kind: v.kind,
        scheduledAt: zonedInstant(v.date, v.time, branch.timeZone ?? ctx.timeZone),
        location: v.location ?? null,
        interviewerUserId: v.interviewerUserId,
        createdByUserId: ctx.userId,
      },
    });
    if (a.stage === "SCREENING") await moveInTx(tx, ctx, a.id, "SCREENING", "INTERVIEW", null);
    await touch(tx, a.candidateId);
    return i;
  });
}

export async function cancelInterview(ctx: TenantContext, interviewId: string) {
  const id = uuidSchema.safeParse(interviewId);
  if (!id.success) throw notFound("Interview");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const i = await tx.interview.findFirst({
      where: {
        organizationId: ctx.organizationId,
        id: id.data,
        application: { opening: openingWhere(ctx) },
      },
      include: { application: { include: { opening: { select: { branchId: true } } } } },
    });
    if (!i) throw notFound("Interview");
    if (!mayManageAt(ctx, i.application.opening.branchId)) throw forbidden();
    if (i.status !== "SCHEDULED")
      throw businessRuleViolation(
        "INTERVIEW_NOT_SCHEDULED",
        "This interview is no longer scheduled",
      );
    await tx.interview.update({ where: { id: i.id }, data: { status: "CANCELLED" } });
    return { applicationId: i.applicationId };
  });
}

/** The interviewer's scorecard: a 1–5 rating and a recommendation, once the interview has begun. */
export async function submitScorecard(ctx: TenantContext, interviewId: string, rawInput: unknown) {
  const parsed = z
    .object({
      rating: z.coerce.number({ error: "invalidNumber" }).int().min(1).max(5),
      recommendation: z.enum(RECOMMENDATIONS, { error: "invalidOption" }),
      notes: optionalText(2000),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const id = uuidSchema.safeParse(interviewId);
  if (!id.success) throw notFound("Interview");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const i = await tx.interview.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data, interviewerUserId: ctx.userId },
      include: { application: { select: { candidateId: true } } },
    });
    if (!i) throw notFound("Interview");
    if (i.status !== "SCHEDULED")
      throw businessRuleViolation(
        "INTERVIEW_NOT_SCHEDULED",
        "This interview is no longer scheduled",
      );
    if (i.scheduledAt > new Date())
      throw businessRuleViolation(
        "INTERVIEW_NOT_YET",
        "Score the interview once it has taken place",
      );
    await tx.interview.update({
      where: { id: i.id },
      data: {
        status: "DONE",
        rating: parsed.data.rating,
        recommendation: parsed.data.recommendation,
        notes: parsed.data.notes ?? null,
        submittedAt: new Date(),
      },
    });
    await touch(tx, i.application.candidateId);
  });
}

/** Interviews the signed-in user runs: upcoming and to score, and the last ones scored. */
export async function myInterviews(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.interview.findMany({
      where: {
        organizationId: ctx.organizationId,
        interviewerUserId: ctx.userId,
        OR: [
          { status: "SCHEDULED" },
          { status: "DONE", submittedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        ],
      },
      include: {
        application: {
          select: {
            candidate: { select: { firstName: true, lastName: true } },
            opening: {
              select: {
                number: true,
                jobTitle: true,
                branch: { select: { code: true, timeZone: true } },
              },
            },
          },
        },
      },
      orderBy: { scheduledAt: "asc" },
    });
    const now = new Date();
    return rows.map((i) => ({ ...i, mayScore: i.status === "SCHEDULED" && i.scheduledAt <= now }));
  });
}

// ─── Hiring ───

const hireSchema = z.object({
  hireDate: date,
  managerId: blank.pipe(uuidSchema.nullable()),
  onboardingTemplateId: blank.pipe(uuidSchema.nullable()),
});

/**
 * Hire a candidate at the offer stage: the employee is created from the
 * candidate and the opening (HR at the branch), the application is closed
 * as hired, the opening fills with its last place, and an onboarding
 * checklist starts when one is chosen — all in one transaction.
 */
export async function hireCandidate(ctx: TenantContext, applicationId: string, rawInput: unknown) {
  const parsed = hireSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const a = await loadApplication(tx, ctx, applicationId);
      if (!hasPermission(ctx.grants, "hr.manage", { branchId: a.opening.branchId }))
        throw forbidden();
      if (a.stage !== "OFFER")
        throw businessRuleViolation("HIRE_NOT_OFFER", "Hire a candidate who was made an offer");
      // One hire at a time per opening, so the last place is not taken twice.
      await tx.$queryRaw`SELECT 1 FROM "job_openings" WHERE "id" = ${a.openingId}::uuid FOR UPDATE`;
      const o = await tx.jobOpening.findUniqueOrThrow({ where: { id: a.openingId } });
      if (o.status !== "OPEN" || o.hired >= o.headcount)
        throw businessRuleViolation("OPENING_NOT_OPEN", "This opening has no place left");
      const e = await createEmployeeInTx(tx, ctx, {
        firstName: a.candidate.firstName,
        lastName: a.candidate.lastName,
        email: a.candidate.email ?? "",
        phone: a.candidate.phone ?? "",
        jobTitle: o.jobTitle,
        branchId: o.branchId,
        departmentId: o.departmentId ?? "",
        managerId: v.managerId ?? "",
        employmentType: o.employmentType,
        hireDate: v.hireDate,
      });
      await moveInTx(tx, ctx, a.id, "OFFER", "HIRED", null, { employeeId: e.id });
      const filled = o.hired + 1 === o.headcount;
      await tx.jobOpening.update({
        where: { id: o.id },
        data: {
          hired: { increment: 1 },
          ...(filled ? { status: "FILLED", closedAt: new Date() } : {}),
        },
      });
      await touch(tx, a.candidateId);
      if (v.onboardingTemplateId)
        await startOnboardingInTx(tx, ctx, e.id, { templateId: v.onboardingTemplateId });
      await recordAudit(tx, actorOf(ctx), {
        action: "job_opening.hired",
        entityType: "job_opening",
        entityId: o.id,
        changes: { employeeId: e.id, filled },
      });
      return { employeeId: e.id, filled };
    });
  } catch (error) {
    throw employeeUniqueError(error);
  }
}

// ─── Needs attention ───

export async function recruitmentAttentionInTx(tx: Tx, ctx: TenantContext) {
  const toApprove = isOrgHr(ctx)
    ? await tx.jobOpening.count({
        where: {
          organizationId: ctx.organizationId,
          status: "PENDING_APPROVAL",
          requestedByUserId: { not: ctx.userId },
        },
      })
    : 0;
  const toScore = await tx.interview.count({
    where: {
      organizationId: ctx.organizationId,
      interviewerUserId: ctx.userId,
      status: "SCHEDULED",
      scheduledAt: { lte: new Date() },
    },
  });
  return { toApprove, toScore };
}

/** Whether to show "My interviews": the user recruits or has interviews to run. */
export async function showsMyInterviews(ctx: TenantContext) {
  if (canViewRecruitment(ctx)) return true;
  return withTenantTx(ctx.organizationId, async (tx) =>
    Boolean(
      await tx.interview.findFirst({
        where: { organizationId: ctx.organizationId, interviewerUserId: ctx.userId },
        select: { id: true },
      }),
    ),
  );
}
