import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { isCalendarDate } from "@/lib/dates";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import {
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { findingCounts, isFoodSafetyComplaint, ncSeverityForFinding } from "./quality-rules";
import { loadBranch, openNonConformanceInTx } from "./service";

/**
 * Audits and customer complaints (DECISIONS.md ADR-098), both feeding the
 * non-conformance and corrective-action workflow (ADR-035). An audit is
 * planned for a branch, its findings are recorded as it is carried out —
 * each one above an observation opens a non-conformance at once — and it is
 * completed with the auditor's own result. A complaint is logged by anyone
 * who records food safety at the branch; one about a foreign object,
 * illness or an allergen opens a HIGH non-conformance in the same
 * transaction; it is investigated and resolved by a food safety manager.
 */

export const AUDIT_TYPES = ["INTERNAL", "EXTERNAL", "AUTHORITY", "CUSTOMER"] as const;
export const FINDING_SEVERITIES = ["OBSERVATION", "MINOR", "MAJOR", "CRITICAL"] as const;
export const COMPLAINT_CHANNELS = [
  "IN_PERSON",
  "PHONE",
  "EMAIL",
  "ONLINE",
  "DELIVERY_PLATFORM",
  "SOCIAL_MEDIA",
  "OTHER",
] as const;
export const COMPLAINT_CATEGORIES = [
  "FOREIGN_OBJECT",
  "ILLNESS",
  "ALLERGEN",
  "QUALITY",
  "TEMPERATURE",
  "HYGIENE",
  "SERVICE",
  "OTHER",
] as const;

const date = z
  .string()
  .transform((v) => v.trim())
  .refine(isCalendarDate, { error: "invalidDate" });
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

const auditSchema = z.object({
  branchId: uuidSchema,
  type: z.enum(AUDIT_TYPES, { error: "invalidOption" }),
  auditor: requiredText(160),
  scope: requiredText(1000),
  plannedOn: date,
});
const findingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES, { error: "invalidOption" }),
  reference: optionalText(120),
  description: requiredText(1000),
});
const completeSchema = z.object({
  conductedOn: date,
  result: optionalText(120),
  summary: optionalText(2000),
});
const reasonSchema = z.object({ reason: requiredText(500) });

const complaintSchema = z.object({
  branchId: uuidSchema,
  receivedOn: date,
  channel: z.enum(COMPLAINT_CHANNELS, { error: "invalidOption" }),
  category: z.enum(COMPLAINT_CATEGORIES, { error: "invalidOption" }),
  customerName: optionalText(160),
  customerContact: optionalText(160),
  orderReference: optionalText(80),
  productId: optionalUuidSchema,
  lotCode: optionalText(80),
  description: requiredText(2000),
});
const investigateSchema = z.object({ investigation: requiredText(2000) });
const resolveSchema = z.object({
  resolution: requiredText(2000),
  customerResponse: optionalText(1000),
});

const branchWhere = (ctx: TenantContext) => {
  const s = accessibleScope(ctx.grants, "foodsafety.view");
  return s.all ? {} : { branchId: { in: s.branchIds } };
};

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entity: { id: string; number: string },
  type: "audit" | "complaint",
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${type}.${action}`,
    entityType: type,
    entityId: entity.id,
    changes: { number: entity.number, ...changes },
  });
}

// ─── Audits ───

export async function planAudit(ctx: TenantContext, rawInput: unknown) {
  const parsed = auditSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await loadBranch(tx, ctx, v.branchId, "foodsafety.manage");
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "AUD",
      Number(v.plannedOn.slice(0, 4)),
    );
    const row = await tx.audit.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        branchId: branch.id,
        type: v.type,
        auditor: v.auditor,
        scope: v.scope,
        plannedOn: asDate(v.plannedOn),
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await audit(tx, ctx, row, "audit", "planned", { ...v });
    return row;
  });
}

async function openAudit(tx: Tx, ctx: TenantContext, auditId: string) {
  await tx.$queryRaw`SELECT 1 FROM "audits" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${auditId}::uuid FOR UPDATE`;
  const a = await tx.audit.findFirst({
    where: { organizationId: ctx.organizationId, id: auditId },
  });
  if (!a || !hasPermission(ctx.grants, "foodsafety.view", { branchId: a.branchId }))
    throw notFound("Audit");
  const branch = await loadBranch(tx, ctx, a.branchId, "foodsafety.manage");
  if (a.status !== "PLANNED")
    throw businessRuleViolation("AUDIT_CLOSED", "The audit is completed or cancelled");
  return { ...a, branch };
}

/** Record a finding; anything above an observation opens a non-conformance at once. */
export async function addAuditFinding(ctx: TenantContext, auditId: string, rawInput: unknown) {
  const parsed = findingSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const a = await openAudit(tx, ctx, auditId);
    const severity = ncSeverityForFinding(v.severity);
    const nc = severity
      ? await openNonConformanceInTx(tx, ctx, {
          branchId: a.branchId,
          timeZone: a.branch.timeZone,
          title: `Audit ${a.number} — ${v.severity.toLowerCase()} finding${v.reference ? ` (${v.reference})` : ""}`,
          description: `${v.description}\nAuditor: ${a.auditor}`,
          severity,
          source: "AUDIT",
        })
      : null;
    const finding = await tx.auditFinding.create({
      data: {
        organizationId: ctx.organizationId,
        auditId: a.id,
        severity: v.severity,
        reference: v.reference ?? null,
        description: v.description,
        nonConformanceId: nc?.id ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await audit(tx, ctx, a, "audit", "finding_added", { ...v, nonConformance: nc?.number ?? null });
    return { id: finding.id, nonConformance: nc };
  });
}

export async function completeAudit(ctx: TenantContext, auditId: string, rawInput: unknown) {
  const parsed = completeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const a = await openAudit(tx, ctx, auditId);
    if (v.conductedOn > businessDate(a.branch.timeZone ?? ctx.timeZone))
      throw businessRuleViolation(
        "AUDIT_IN_FUTURE",
        "An audit cannot be completed before it takes place",
        {
          field: "conductedOn",
        },
      );
    await tx.audit.update({
      where: { id: a.id },
      data: {
        status: "COMPLETED",
        conductedOn: asDate(v.conductedOn),
        result: v.result ?? null,
        summary: v.summary ?? null,
        completedAt: new Date(),
        completedByUserId: ctx.userId,
      },
    });
    await audit(tx, ctx, a, "audit", "completed", v);
  });
}

export async function cancelAudit(ctx: TenantContext, auditId: string, rawInput: unknown) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const a = await openAudit(tx, ctx, auditId);
    const findings = await tx.auditFinding.count({
      where: { organizationId: ctx.organizationId, auditId: a.id },
    });
    if (findings > 0)
      throw businessRuleViolation(
        "AUDIT_HAS_FINDINGS",
        "An audit with findings is completed, not cancelled",
      );
    await tx.audit.update({
      where: { id: a.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: parsed.data.reason },
    });
    await audit(tx, ctx, a, "audit", "cancelled", { reason: parsed.data.reason });
  });
}

export async function listAudits(ctx: TenantContext) {
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.audit.findMany({
      where: { organizationId: ctx.organizationId, ...branchWhere(ctx) },
      include: {
        branch: { select: { code: true, name: true } },
        findings: { select: { severity: true } },
      },
      orderBy: [{ plannedOn: "desc" }, { number: "desc" }],
      take: 200,
    });
    const today = businessDate(ctx.timeZone);
    return rows.map((a) => ({
      ...a,
      counts: findingCounts(a.findings.map((f) => f.severity)),
      overdue: a.status === "PLANNED" && a.plannedOn.toISOString().slice(0, 10) < today,
    }));
  });
}

export async function getAudit(ctx: TenantContext, auditId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const a = await tx.audit.findFirst({
      where: { organizationId: ctx.organizationId, id: auditId },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        findings: {
          include: { nonConformance: { select: { id: true, number: true, status: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!a || !hasPermission(ctx.grants, "foodsafety.view", { branchId: a.branchId }))
      throw notFound("Audit");
    const manage = hasPermission(ctx.grants, "foodsafety.manage", { branchId: a.branchId });
    return {
      audit: a,
      counts: findingCounts(a.findings.map((f) => f.severity)),
      can: { edit: manage && a.status === "PLANNED" },
    };
  });
}

// ─── Complaints ───

/** Log a complaint. Food safety ones open a HIGH non-conformance straight away. */
export async function logComplaint(ctx: TenantContext, rawInput: unknown) {
  const parsed = complaintSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await loadBranch(tx, ctx, v.branchId, "foodsafety.record");
    const today = businessDate(branch.timeZone ?? ctx.timeZone);
    if (v.receivedOn > today)
      throw businessRuleViolation(
        "COMPLAINT_IN_FUTURE",
        "A complaint cannot be received in the future",
        {
          field: "receivedOn",
        },
      );
    let product: { id: string; sku: string; nameEn: string } | null = null;
    let lotId: string | null = null;
    if (v.productId) {
      product = await tx.product.findFirst({
        where: { organizationId: ctx.organizationId, id: v.productId },
        select: { id: true, sku: true, nameEn: true },
      });
      if (!product) throw notFound("Product");
      if (v.lotCode) {
        const lot = await tx.inventoryLot.findFirst({
          where: { organizationId: ctx.organizationId, productId: product.id, lotCode: v.lotCode },
          select: { id: true },
        });
        if (!lot)
          throw businessRuleViolation("LOT_NOT_FOUND", "No lot with this code for the product", {
            field: "lotCode",
          });
        lotId = lot.id;
      }
    } else if (v.lotCode)
      throw businessRuleViolation("LOT_NEEDS_PRODUCT", "Choose the product the lot belongs to", {
        field: "productId",
      });
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "CMP",
      Number(today.slice(0, 4)),
    );
    const nc = isFoodSafetyComplaint(v.category)
      ? await openNonConformanceInTx(tx, ctx, {
          branchId: branch.id,
          timeZone: branch.timeZone,
          title: `Complaint ${number} — ${v.category.toLowerCase().replace("_", " ")}${product ? `: ${product.sku}` : ""}${v.lotCode ? ` lot ${v.lotCode}` : ""}`,
          description: v.description,
          severity: "HIGH",
          source: "COMPLAINT",
        })
      : null;
    const row = await tx.complaint.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        branchId: branch.id,
        receivedAt: v.receivedOn === today ? new Date() : asDate(v.receivedOn),
        channel: v.channel,
        category: v.category,
        customerName: v.customerName ?? null,
        customerContact: v.customerContact ?? null,
        orderReference: v.orderReference ?? null,
        productId: product?.id ?? null,
        lotId,
        description: v.description,
        nonConformanceId: nc?.id ?? null,
        recordedByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    // Personal contact details stay out of the audit log.
    await audit(tx, ctx, row, "complaint", "logged", {
      branchId: branch.id,
      channel: v.channel,
      category: v.category,
      productId: product?.id ?? null,
      lotCode: v.lotCode ?? null,
      nonConformance: nc?.number ?? null,
    });
    return { ...row, nonConformance: nc };
  });
}

async function openComplaint(tx: Tx, ctx: TenantContext, complaintId: string) {
  await tx.$queryRaw`SELECT 1 FROM "complaints" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${complaintId}::uuid FOR UPDATE`;
  const c = await tx.complaint.findFirst({
    where: { organizationId: ctx.organizationId, id: complaintId },
  });
  if (!c || !hasPermission(ctx.grants, "foodsafety.view", { branchId: c.branchId }))
    throw notFound("Complaint");
  await loadBranch(tx, ctx, c.branchId, "foodsafety.manage");
  if (c.status === "RESOLVED")
    throw businessRuleViolation("COMPLAINT_RESOLVED", "The complaint is resolved");
  return c;
}

export async function investigateComplaint(
  ctx: TenantContext,
  complaintId: string,
  rawInput: unknown,
) {
  const parsed = investigateSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await openComplaint(tx, ctx, complaintId);
    await tx.complaint.update({
      where: { id: c.id },
      data: { status: "INVESTIGATING", investigation: parsed.data.investigation },
    });
    await audit(tx, ctx, c, "complaint", "investigated", parsed.data);
  });
}

/** Raise a non-conformance from a complaint that is not food safety by category (e.g. hygiene). */
export async function raiseComplaintNonConformance(ctx: TenantContext, complaintId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await openComplaint(tx, ctx, complaintId);
    if (c.nonConformanceId)
      throw businessRuleViolation(
        "COMPLAINT_HAS_NC",
        "A non-conformance is already open for this complaint",
      );
    const branch = await loadBranch(tx, ctx, c.branchId, "foodsafety.manage");
    const nc = await openNonConformanceInTx(tx, ctx, {
      branchId: c.branchId,
      timeZone: branch.timeZone,
      title: `Complaint ${c.number} — ${c.category.toLowerCase().replace("_", " ")}`,
      description: c.description,
      severity: "MEDIUM",
      source: "COMPLAINT",
    });
    await tx.complaint.update({ where: { id: c.id }, data: { nonConformanceId: nc.id } });
    await audit(tx, ctx, c, "complaint", "nc_raised", { nonConformance: nc.number });
    return nc;
  });
}

export async function resolveComplaint(ctx: TenantContext, complaintId: string, rawInput: unknown) {
  const parsed = resolveSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await openComplaint(tx, ctx, complaintId);
    await tx.complaint.update({
      where: { id: c.id },
      data: {
        status: "RESOLVED",
        resolution: parsed.data.resolution,
        customerResponse: parsed.data.customerResponse ?? null,
        resolvedAt: new Date(),
        resolvedByUserId: ctx.userId,
      },
    });
    await audit(tx, ctx, c, "complaint", "resolved", { resolution: parsed.data.resolution });
  });
}

export async function listComplaints(
  ctx: TenantContext,
  filters: { open?: boolean; category?: (typeof COMPLAINT_CATEGORIES)[number] } = {},
) {
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) throw forbidden();
  const where: Prisma.ComplaintWhereInput = {
    organizationId: ctx.organizationId,
    ...branchWhere(ctx),
    ...(filters.open ? { status: { not: "RESOLVED" } } : {}),
    ...(filters.category ? { category: filters.category } : {}),
  };
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.complaint.findMany({
      where,
      select: {
        id: true,
        number: true,
        receivedAt: true,
        channel: true,
        category: true,
        status: true,
        description: true,
        branch: { select: { code: true } },
        product: { select: { sku: true, nameEn: true, nameAr: true } },
        nonConformance: { select: { id: true, number: true } },
      },
      orderBy: { receivedAt: "desc" },
      take: 200,
    }),
  );
}

export async function getComplaint(ctx: TenantContext, complaintId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.complaint.findFirst({
      where: { organizationId: ctx.organizationId, id: complaintId },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        product: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
        nonConformance: { select: { id: true, number: true, status: true } },
      },
    });
    if (!c || !hasPermission(ctx.grants, "foodsafety.view", { branchId: c.branchId }))
      throw notFound("Complaint");
    const lot = c.lotId
      ? await tx.inventoryLot.findFirst({
          where: { organizationId: ctx.organizationId, id: c.lotId },
          select: { id: true, lotCode: true, expiresOn: true },
        })
      : null;
    const manage = hasPermission(ctx.grants, "foodsafety.manage", { branchId: c.branchId });
    return {
      complaint: c,
      lot,
      can: {
        investigate: manage && c.status !== "RESOLVED",
        resolve: manage && c.status !== "RESOLVED",
        raiseNc: manage && c.status !== "RESOLVED" && !c.nonConformanceId,
      },
    };
  });
}

/** Attention list: open complaints and planned audits whose date has passed. */
export async function qualityAttention(tx: Tx, ctx: TenantContext) {
  const today = asDate(businessDate(ctx.timeZone));
  const [openComplaints, auditsOverdue] = [
    await tx.complaint.count({
      where: {
        organizationId: ctx.organizationId,
        status: { not: "RESOLVED" },
        ...branchWhere(ctx),
      },
    }),
    await tx.audit.count({
      where: {
        organizationId: ctx.organizationId,
        status: "PLANNED",
        plannedOn: { lt: today },
        ...branchWhere(ctx),
      },
    }),
  ];
  return { openComplaints, auditsOverdue };
}
