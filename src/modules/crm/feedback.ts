import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { logComplaint, COMPLAINT_CATEGORIES } from "@/modules/foodsafety/quality";
import { integrationKey } from "@/modules/integrations/crypto";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { optionalText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { FEEDBACK_DAYS, LOW_RATING, ratingSummary } from "./rules";

/**
 * Guest feedback (DECISIONS.md ADR-118). Every paid order's receipt carries
 * a link signed with the integration key (HMAC-SHA256 of the order), so it
 * cannot be guessed; the guest rates the order 1–5 with an optional comment,
 * once, within 14 days. Nothing about the guest is asked or kept. Low
 * ratings wait for a manager to review them or turn them into a complaint
 * (ADR-098). Viewing needs `customers.view`, reviewing `customers.manage`.
 */

function signature(orderId: string) {
  const env = getEnv();
  return createHmac("sha256", integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET))
    .update(`feedback:${orderId}`)
    .digest("base64url")
    .slice(0, 22);
}

/** The token on the receipt: the order and its signature. */
export const feedbackToken = (orderId: string) => `${orderId}.${signature(orderId)}`;
export const feedbackUrl = (orderId: string) =>
  `${getEnv().APP_URL}/feedback/${feedbackToken(orderId)}`;

function verify(token: string): string | null {
  const [orderId, sig] = token.split(".");
  if (!orderId || !sig || !isUuid(orderId)) return null;
  const expected = Buffer.from(signature(orderId));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? orderId : null;
}

async function orderForToken(token: string) {
  const orderId = verify(token);
  if (!orderId) return null;
  return withSystemTx((tx) =>
    tx.posOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        organizationId: true,
        number: true,
        status: true,
        businessDate: true,
        branchId: true,
        customerId: true,
        register: { select: { branch: { select: { name: true, timeZone: true } } } },
        organization: { select: { name: true, timeZone: true } },
        feedback: { select: { id: true } },
      },
    }),
  );
}

const open = (o: {
  businessDate: Date;
  register: { branch: { timeZone: string | null } };
  organization: { timeZone: string };
}) =>
  businessDate(o.register.branch.timeZone ?? o.organization.timeZone) <=
  addDays(o.businessDate.toISOString().slice(0, 10), FEEDBACK_DAYS);

/** What the public page shows for a link; null when it is not valid. */
export async function feedbackPage(token: string) {
  const o = await orderForToken(token);
  if (!o || o.status !== "PAID") return null;
  return {
    orderNumber: o.number,
    branchName: o.register.branch.name,
    organizationName: o.organization.name,
    given: Boolean(o.feedback),
    closed: !open(o),
  };
}

const submitSchema = z.object({
  rating: z.coerce
    .number()
    .int()
    .min(1, { error: "invalidRating" })
    .max(5, { error: "invalidRating" }),
  comment: optionalText(1000),
});

export async function submitFeedback(token: string, rawInput: unknown) {
  const parsed = submitSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const o = await orderForToken(token);
  if (!o || o.status !== "PAID") throw notFound("Order");
  if (!open(o)) throw businessRuleViolation("FEEDBACK_CLOSED", "This link has closed");
  try {
    await withTenantTx(o.organizationId, (tx) =>
      tx.guestFeedback.create({
        data: {
          organizationId: o.organizationId,
          posOrderId: o.id,
          branchId: o.branchId,
          customerId: o.customerId,
          rating: parsed.data.rating,
          comment: parsed.data.comment ?? null,
        },
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("Already rated", { reason: "feedbackGiven" });
    throw error;
  }
}

const listSchema = z.object({
  branchId: z
    .string()
    .optional()
    .transform((v) => (v && isUuid(v) ? v : undefined)),
  from: z.string().optional(),
  to: z.string().optional(),
  low: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "1"),
});

/** Feedback for a period, with a summary per branch and the low ratings still to review. */
export async function listFeedback(ctx: TenantContext, rawFilters: unknown = {}) {
  assertPermission(ctx.grants, "customers.view");
  const f = listSchema.parse(rawFilters);
  const today = businessDate(ctx.timeZone);
  const from = f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from) ? f.from : addDays(today, -29);
  const to = f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? f.to : today;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.guestFeedback.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(f.branchId ? { branchId: f.branchId } : {}),
        ...(f.low ? { rating: { lte: LOW_RATING } } : {}),
        posOrder: {
          businessDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
      },
      include: {
        branch: { select: { code: true, name: true } },
        posOrder: { select: { number: true, channel: true, businessDate: true } },
        customer: { select: { name: true } },
        complaint: { select: { id: true, number: true } },
      },
      orderBy: { submittedAt: "desc" },
      take: 1000,
    });
    const branches = [...new Map(rows.map((r) => [r.branchId, r.branch])).entries()];
    return {
      from,
      to,
      summary: ratingSummary(rows.map((r) => r.rating)),
      byBranch: branches.map(([id, b]) => ({
        branchId: id,
        branch: b,
        ...ratingSummary(rows.filter((r) => r.branchId === id).map((r) => r.rating)),
      })),
      rows,
      canManage: hasPermission(ctx.grants, "customers.manage"),
    };
  });
}

async function loadFeedback(ctx: TenantContext, feedbackId: string) {
  assertPermission(ctx.grants, "customers.manage");
  if (!isUuid(feedbackId)) throw notFound("Feedback");
  const fb = await withTenantTx(ctx.organizationId, (tx) =>
    tx.guestFeedback.findFirst({
      where: { organizationId: ctx.organizationId, id: feedbackId },
      include: {
        posOrder: { select: { number: true, channel: true } },
        customer: { select: { name: true } },
      },
    }),
  );
  if (!fb) throw notFound("Feedback");
  if (fb.reviewedAt) throw businessRuleViolation("FEEDBACK_REVIEWED", "Already reviewed");
  return fb;
}

/** A manager has read it and done what was needed. */
export async function reviewFeedback(ctx: TenantContext, feedbackId: string, rawInput: unknown) {
  const parsed = z.object({ note: optionalText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const fb = await loadFeedback(ctx, feedbackId);
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.guestFeedback.update({
      where: { id: fb.id },
      data: {
        reviewedAt: new Date(),
        reviewedByUserId: ctx.userId,
        reviewNote: parsed.data.note ?? null,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "guest_feedback.reviewed",
      entityType: "guest_feedback",
      entityId: fb.id,
      changes: {},
    });
  });
}

/** Turn it into a customer complaint at its branch (needs `foodsafety.record` there too). */
export async function escalateFeedback(ctx: TenantContext, feedbackId: string, rawInput: unknown) {
  const parsed = z
    .object({ category: z.enum(COMPLAINT_CATEGORIES, { error: "invalidOption" }) })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const fb = await loadFeedback(ctx, feedbackId);
  const complaint = await logComplaint(ctx, {
    branchId: fb.branchId,
    receivedOn: fb.submittedAt.toISOString().slice(0, 10),
    channel: fb.posOrder.channel === "DELIVERY" ? "DELIVERY_PLATFORM" : "ONLINE",
    category: parsed.data.category,
    customerName: fb.customer?.name ?? "",
    orderReference: fb.posOrder.number,
    description: fb.comment ?? `Rated ${fb.rating} of 5 without a comment.`,
  });
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.guestFeedback.update({
      where: { id: fb.id },
      data: { reviewedAt: new Date(), reviewedByUserId: ctx.userId, complaintId: complaint.id },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "guest_feedback.escalated",
      entityType: "guest_feedback",
      entityId: fb.id,
      changes: { complaintId: complaint.id },
    });
  });
  return complaint;
}
