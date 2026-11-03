import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import { optionalText, optionalUuidSchema, requiredText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";

/**
 * Document control (DECISIONS.md ADR-097): SOPs, policies, work
 * instructions, forms and manuals. A document's text lives in versions; a
 * version is written as a draft, approved by someone other than its author
 * with the date it takes effect and a review date, and is then fixed. The
 * next approved version supersedes it. Staff confirm they have read the
 * version in force. A document no longer used is withdrawn, never deleted.
 */

export const FS_DOCUMENT_TYPES = [
  "POLICY",
  "SOP",
  "WORK_INSTRUCTION",
  "FORM",
  "MANUAL",
  "OTHER",
] as const;

const code = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .refine((v) => /^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(v), { error: "invalidCode" });
const content = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, { error: "required" })
  .refine((v) => v.length <= 50_000, { error: "tooLong" });
const date = z
  .string()
  .transform((v) => v.trim())
  .refine(isCalendarDate, { error: "invalidDate" });

const createSchema = z.object({
  code,
  title: requiredText(200),
  type: z.enum(FS_DOCUMENT_TYPES, { error: "invalidOption" }),
  branchId: optionalUuidSchema,
  content,
  changeSummary: optionalText(500),
});
const draftSchema = z.object({
  title: requiredText(200),
  content,
  changeSummary: optionalText(500),
});
const approveSchema = z.object({ effectiveFrom: date, reviewDueOn: date });
const reasonSchema = z.object({ reason: requiredText(500) });

const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);

// ─── Access (as HACCP plans, ADR-096) ───

function canView(ctx: TenantContext, doc: { branchId: string | null }) {
  return doc.branchId
    ? hasPermission(ctx.grants, "foodsafety.view", { branchId: doc.branchId })
    : holdsAnyGrant(ctx.grants, "foodsafety.view");
}
function canManage(ctx: TenantContext, doc: { branchId: string | null }) {
  return doc.branchId
    ? hasPermission(ctx.grants, "foodsafety.manage", { branchId: doc.branchId })
    : hasPermission(ctx.grants, "foodsafety.manage");
}
function assertManage(ctx: TenantContext, doc: { branchId: string | null }) {
  if (!canManage(ctx, doc)) throw forbidden();
}

function visibleWhere(ctx: TenantContext): Prisma.FsDocumentWhereInput {
  const scope = accessibleScope(ctx.grants, "foodsafety.view");
  if (scope.all) return {};
  return { OR: [{ branchId: null }, { branchId: { in: scope.branchIds } }] };
}

async function loadDocument(tx: Tx, ctx: TenantContext, documentId: string, lock = false) {
  if (lock)
    await tx.$queryRaw`SELECT 1 FROM "fs_documents" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${documentId}::uuid FOR UPDATE`;
  const doc = await tx.fsDocument.findFirst({
    where: { organizationId: ctx.organizationId, id: documentId },
  });
  if (!doc || !canView(ctx, doc)) throw notFound("Document");
  return doc;
}

async function manageable(tx: Tx, ctx: TenantContext, documentId: string) {
  const doc = await loadDocument(tx, ctx, documentId, true);
  assertManage(ctx, doc);
  if (doc.withdrawnAt)
    throw businessRuleViolation("DOCUMENT_WITHDRAWN", "The document has been withdrawn");
  return doc;
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  doc: { id: string; code: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `fs_document.${action}`,
    entityType: "fs_document",
    entityId: doc.id,
    changes: { code: doc.code, ...changes },
  });
}

const draftOf = (tx: Tx, ctx: TenantContext, documentId: string) =>
  tx.fsDocumentVersion.findFirst({
    where: { organizationId: ctx.organizationId, documentId, status: "DRAFT" },
  });
const currentOf = (tx: Tx, ctx: TenantContext, documentId: string) =>
  tx.fsDocumentVersion.findFirst({
    where: { organizationId: ctx.organizationId, documentId, status: "APPROVED" },
  });

// ─── Writing ───

/** A new document with its first draft. */
export async function createFsDocument(ctx: TenantContext, rawInput: unknown) {
  const parsed = createSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  assertManage(ctx, { branchId: v.branchId ?? null });
  return withTenantTx(ctx.organizationId, async (tx) => {
    if (v.branchId) {
      const b = await tx.branch.count({
        where: { organizationId: ctx.organizationId, id: v.branchId },
      });
      if (b === 0) throw notFound("Branch");
    }
    if (
      (await tx.fsDocument.count({ where: { organizationId: ctx.organizationId, code: v.code } })) >
      0
    )
      throw conflict("A document with this code exists", { field: "code", reason: "codeTaken" });
    const doc = await tx.fsDocument.create({
      data: {
        organizationId: ctx.organizationId,
        code: v.code,
        title: v.title,
        type: v.type,
        branchId: v.branchId ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, code: true },
    });
    await tx.fsDocumentVersion.create({
      data: {
        organizationId: ctx.organizationId,
        documentId: doc.id,
        version: 1,
        content: v.content,
        changeSummary: v.changeSummary ?? null,
        createdByUserId: ctx.userId,
      },
    });
    await audit(tx, ctx, doc, "created", { title: v.title, type: v.type });
    return doc;
  });
}

export async function updateFsDocumentDraft(
  ctx: TenantContext,
  documentId: string,
  rawInput: unknown,
) {
  const parsed = draftSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await manageable(tx, ctx, documentId);
    const draft = await draftOf(tx, ctx, doc.id);
    if (!draft) throw businessRuleViolation("NO_DRAFT_VERSION", "Start a new version first");
    await tx.fsDocumentVersion.update({
      where: { id: draft.id },
      data: { content: v.content, changeSummary: v.changeSummary ?? null },
    });
    if (v.title !== doc.title)
      await tx.fsDocument.update({ where: { id: doc.id }, data: { title: v.title } });
    await audit(tx, ctx, doc, "draft_updated", { version: draft.version, title: v.title });
  });
}

/** Approve the draft (someone other than its author); the version in force is superseded. */
export async function approveFsDocument(ctx: TenantContext, documentId: string, rawInput: unknown) {
  const parsed = approveSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await manageable(tx, ctx, documentId);
    const draft = await draftOf(tx, ctx, doc.id);
    if (!draft) throw businessRuleViolation("NO_DRAFT_VERSION", "There is no draft to approve");
    if (draft.createdByUserId === ctx.userId)
      throw businessRuleViolation(
        "DOCUMENT_SELF_APPROVAL",
        "A document must be approved by someone other than the person who wrote the version",
      );
    const today = businessDate(ctx.timeZone);
    if (v.effectiveFrom < today)
      throw businessRuleViolation(
        "EFFECTIVE_DATE_PAST",
        "A version cannot take effect in the past",
        {
          field: "effectiveFrom",
        },
      );
    if (v.reviewDueOn <= v.effectiveFrom)
      throw businessRuleViolation(
        "REVIEW_DATE_PAST",
        "The review date must come after it takes effect",
        {
          field: "reviewDueOn",
        },
      );
    const now = new Date();
    const superseded = await tx.fsDocumentVersion.updateMany({
      where: { organizationId: ctx.organizationId, documentId: doc.id, status: "APPROVED" },
      data: { status: "SUPERSEDED", supersededAt: now },
    });
    await tx.fsDocumentVersion.update({
      where: { id: draft.id },
      data: {
        status: "APPROVED",
        approvedAt: now,
        approvedByUserId: ctx.userId,
        effectiveFrom: asDate(v.effectiveFrom),
        reviewDueOn: asDate(v.reviewDueOn),
      },
    });
    await audit(tx, ctx, doc, "approved", {
      version: draft.version,
      ...v,
      superseded: superseded.count,
    });
  });
}

/** A new draft copied from the version in force; that version stays in force until the draft is approved. */
export async function newFsDocumentVersion(ctx: TenantContext, documentId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await manageable(tx, ctx, documentId);
    if (await draftOf(tx, ctx, doc.id))
      throw businessRuleViolation("DRAFT_EXISTS", "A new version is already being written");
    const current = await currentOf(tx, ctx, doc.id);
    if (!current)
      throw businessRuleViolation("NO_APPROVED_VERSION", "Approve the first version first");
    const latest = await tx.fsDocumentVersion.aggregate({
      where: { organizationId: ctx.organizationId, documentId: doc.id },
      _max: { version: true },
    });
    const draft = await tx.fsDocumentVersion.create({
      data: {
        organizationId: ctx.organizationId,
        documentId: doc.id,
        version: (latest._max.version ?? current.version) + 1,
        content: current.content,
        createdByUserId: ctx.userId,
      },
      select: { id: true, version: true },
    });
    await audit(tx, ctx, doc, "version_started", { version: draft.version });
    return draft;
  });
}

export async function withdrawFsDocument(
  ctx: TenantContext,
  documentId: string,
  rawInput: unknown,
) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await manageable(tx, ctx, documentId);
    await tx.fsDocument.update({
      where: { id: doc.id },
      data: {
        withdrawnAt: new Date(),
        withdrawnByUserId: ctx.userId,
        withdrawReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, doc, "withdrawn", { reason: parsed.data.reason });
  });
}

/** Confirm having read the version in force. */
export async function confirmFsDocumentRead(ctx: TenantContext, documentId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await loadDocument(tx, ctx, documentId);
    if (doc.withdrawnAt)
      throw businessRuleViolation("DOCUMENT_WITHDRAWN", "The document has been withdrawn");
    const current = await currentOf(tx, ctx, doc.id);
    if (!current) throw businessRuleViolation("NO_APPROVED_VERSION", "No version is in force yet");
    await tx.fsDocumentRead.upsert({
      where: {
        organizationId_versionId_userId: {
          organizationId: ctx.organizationId,
          versionId: current.id,
          userId: ctx.userId,
        },
      },
      create: { organizationId: ctx.organizationId, versionId: current.id, userId: ctx.userId },
      update: {},
    });
  });
}

// ─── Reading ───

export async function listFsDocuments(
  ctx: TenantContext,
  filters: { type?: (typeof FS_DOCUMENT_TYPES)[number]; withdrawn?: boolean } = {},
) {
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) throw forbidden();
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const docs = await tx.fsDocument.findMany({
      where: {
        organizationId: ctx.organizationId,
        withdrawnAt: filters.withdrawn ? { not: null } : null,
        ...(filters.type ? { type: filters.type } : {}),
        ...visibleWhere(ctx),
      },
      include: {
        branch: { select: { code: true, name: true } },
        versions: {
          where: { status: { in: ["APPROVED", "DRAFT"] } },
          select: {
            id: true,
            version: true,
            status: true,
            effectiveFrom: true,
            reviewDueOn: true,
            reads: { where: { userId: ctx.userId }, select: { readAt: true } },
          },
        },
      },
      orderBy: { code: "asc" },
    });
    return docs.map((d) => {
      const current = d.versions.find((v) => v.status === "APPROVED") ?? null;
      const draft = d.versions.find((v) => v.status === "DRAFT") ?? null;
      return {
        id: d.id,
        code: d.code,
        title: d.title,
        type: d.type,
        branch: d.branch,
        withdrawnAt: d.withdrawnAt,
        current: current && {
          version: current.version,
          effectiveFrom: current.effectiveFrom,
          reviewDueOn: current.reviewDueOn,
          reviewDue: !!current.reviewDueOn && day(current.reviewDueOn) <= today,
          readByMe: current.reads.length > 0,
        },
        draft: draft && { version: draft.version },
      };
    });
  });
}

export async function getFsDocument(ctx: TenantContext, documentId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await loadDocument(tx, ctx, documentId);
    const today = businessDate(ctx.timeZone);
    const [versions, branch] = [
      await tx.fsDocumentVersion.findMany({
        where: { organizationId: ctx.organizationId, documentId: doc.id },
        include: { reads: { select: { userId: true, readAt: true }, orderBy: { readAt: "asc" } } },
        orderBy: { version: "desc" },
      }),
      doc.branchId
        ? await tx.branch.findFirst({
            where: { organizationId: ctx.organizationId, id: doc.branchId },
            select: { code: true, name: true },
          })
        : null,
    ];
    const ids = new Set<string>();
    for (const v of versions) {
      ids.add(v.createdByUserId);
      if (v.approvedByUserId) ids.add(v.approvedByUserId);
      for (const r of v.reads) ids.add(r.userId);
    }
    const users = new Map(
      (
        await tx.user.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u.name]),
    );
    const named = versions.map((v) => ({
      ...v,
      author: users.get(v.createdByUserId) ?? null,
      approver: v.approvedByUserId ? (users.get(v.approvedByUserId) ?? null) : null,
      readers: v.reads.map((r) => ({ name: users.get(r.userId) ?? null, readAt: r.readAt })),
    }));
    const current = named.find((v) => v.status === "APPROVED") ?? null;
    const draft = named.find((v) => v.status === "DRAFT") ?? null;
    const manage = canManage(ctx, doc) && !doc.withdrawnAt;
    return {
      document: { ...doc, branch },
      current,
      draft,
      history: named.filter((v) => v.status === "SUPERSEDED"),
      reviewDue: !!current?.reviewDueOn && day(current.reviewDueOn) <= today,
      readByMe: !!current?.reads.some((r) => r.userId === ctx.userId),
      can: {
        edit: manage && !!draft,
        approve: manage && !!draft && draft.createdByUserId !== ctx.userId,
        newVersion: manage && !draft && !!current,
        withdraw: manage,
        confirmRead: !doc.withdrawnAt && !!current,
      },
    };
  });
}

/** Documents in force whose review date has come (attention list). */
export async function fsDocumentReviewsDue(tx: Tx, ctx: TenantContext) {
  return tx.fsDocumentVersion.count({
    where: {
      organizationId: ctx.organizationId,
      status: "APPROVED",
      reviewDueOn: { lte: asDate(businessDate(ctx.timeZone)) },
      document: { withdrawnAt: null, ...visibleWhere(ctx) },
    },
  });
}

/** Documents in force the user has not confirmed reading (attention list). */
export async function fsDocumentsUnread(tx: Tx, ctx: TenantContext) {
  return tx.fsDocumentVersion.count({
    where: {
      organizationId: ctx.organizationId,
      status: "APPROVED",
      document: { withdrawnAt: null, ...visibleWhere(ctx) },
      reads: { none: { userId: ctx.userId } },
    },
  });
}

/** Attachment access for a version's file: view as the document; add files only to a draft (ADR-051). */
export async function fsDocumentVersionAccess(tx: Tx, ctx: TenantContext, versionId: string) {
  const v = await tx.fsDocumentVersion.findFirst({
    where: { organizationId: ctx.organizationId, id: versionId },
    select: { status: true, document: { select: { branchId: true, withdrawnAt: true } } },
  });
  if (!v || !canView(ctx, v.document)) return null;
  return {
    view: true,
    upload: v.status === "DRAFT" && !v.document.withdrawnAt && canManage(ctx, v.document),
  };
}
