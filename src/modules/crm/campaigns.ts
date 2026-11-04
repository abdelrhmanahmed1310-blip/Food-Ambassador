import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { integrationKey } from "@/modules/integrations/crypto";
import { businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  CAMPAIGN_CHANNELS,
  render,
  smsParts,
  unknownPlaceholders,
  withUnsubscribe,
  type CampaignChannel,
} from "./campaign-rules";
import { providerFor } from "./messaging";
import { matches, type SegmentRules } from "./rules";
import { customerStatsInTx, rulesSchema } from "./segments";

/**
 * Campaigns (DECISIONS.md ADR-119): a message on one channel to a segment's
 * guests — only those who agreed to receive offers (ADR-068) and have a
 * contact for the channel, optionally leaving out those messaged recently.
 * Recipients are fixed at launch and hold no contact details; the phone or
 * e-mail is read when sending, and anyone who withdrew consent or was
 * erased meanwhile is skipped. Every message carries a signed unsubscribe
 * link. Drafting needs `customers.manage`; launching `campaigns.send` and a
 * connected provider for the channel.
 */

const UNSUBSCRIBE_LABEL = "Stop offers:";

const campaignSchema = z
  .object({
    name: requiredText(120),
    channel: z.enum(CAMPAIGN_CHANNELS, { error: "invalidOption" }),
    segmentId: uuidSchema,
    subject: optionalText(150),
    body: requiredText(2000),
    skipIfMessagedWithinDays: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? Number(v) : undefined))
      .refine((v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 365), {
        error: "invalidNumber",
      }),
    attributionDays: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? Number(v) : 7))
      .refine((v) => Number.isInteger(v) && v >= 1 && v <= 60, { error: "invalidNumber" }),
  })
  .refine((v) => v.channel !== "EMAIL" || v.subject, {
    error: "subjectRequired",
    path: ["subject"],
  })
  .refine((v) => unknownPlaceholders(v.body).length === 0, {
    error: "unknownPlaceholder",
    path: ["body"],
  });

async function audit(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  action: string,
  changes: Record<string, unknown>,
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `campaign.${action}`,
    entityType: "campaign",
    entityId: id,
    changes,
  });
}

// ─── Unsubscribe links ───

function signature(recipientId: string) {
  const env = getEnv();
  return createHmac("sha256", integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET))
    .update(`unsubscribe:${recipientId}`)
    .digest("base64url")
    .slice(0, 22);
}
export const unsubscribeUrl = (recipientId: string) =>
  `${getEnv().APP_URL}/unsubscribe/${recipientId}.${signature(recipientId)}`;

function verify(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !isUuid(id)) return null;
  const a = Buffer.from(signature(id));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

// ─── Drafts and audience ───

const contactOf = (channel: CampaignChannel, c: { phone: string | null; email: string | null }) =>
  channel === "EMAIL" ? c.email : c.phone;

/**
 * Who the campaign would reach now: the segment's guests, those who agreed
 * to offers, those with a contact for the channel, less those messaged
 * within the chosen days.
 */
async function audienceInTx(
  tx: Tx,
  ctx: TenantContext,
  c: {
    channel: CampaignChannel;
    segmentId: string;
    skipIfMessagedWithinDays: number | null;
    id?: string;
  },
) {
  const segment = await tx.customerSegment.findFirst({
    where: { organizationId: ctx.organizationId, id: c.segmentId, archivedAt: null },
  });
  if (!segment) throw notFound("Segment");
  const parsed = rulesSchema.safeParse(segment.rules);
  const rules: SegmentRules = parsed.success ? parsed.data : { windowDays: 365 };
  const today = businessDate(ctx.timeZone);
  const inSegment = (await customerStatsInTx(tx, ctx, rules.windowDays)).filter((s) =>
    matches(s, rules, today),
  );
  const consenting = inSegment.filter((s) => s.marketingConsent);
  const people = await tx.posCustomer.findMany({
    where: {
      organizationId: ctx.organizationId,
      id: { in: consenting.map((s) => s.customerId) },
      erasedAt: null,
    },
    select: { id: true, phone: true, email: true },
  });
  const reachable = people.filter((p) => contactOf(c.channel, p));
  let recent = new Set<string>();
  if (c.skipIfMessagedWithinDays) {
    const since = new Date(Date.now() - c.skipIfMessagedWithinDays * 86_400_000);
    const rows = await tx.campaignRecipient.findMany({
      where: {
        organizationId: ctx.organizationId,
        customerId: { in: reachable.map((p) => p.id) },
        status: "SENT",
        sentAt: { gte: since },
        ...(c.id ? { NOT: { campaignId: c.id } } : {}),
      },
      select: { customerId: true },
    });
    recent = new Set(rows.map((r) => r.customerId));
  }
  return {
    segment,
    inSegment: inSegment.length,
    consenting: consenting.length,
    reachable: reachable.length,
    recentlyMessaged: recent.size,
    send: reachable.filter((p) => !recent.has(p.id)).map((p) => p.id),
    skipped: reachable.filter((p) => recent.has(p.id)).map((p) => p.id),
  };
}

export async function saveCampaign(ctx: TenantContext, rawInput: unknown, campaignId?: string) {
  assertPermission(ctx.grants, "customers.manage");
  const parsed = campaignSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const segment = await tx.customerSegment.findFirst({
      where: { organizationId: ctx.organizationId, id: v.segmentId, archivedAt: null },
      select: { id: true },
    });
    if (!segment) throw notFound("Segment");
    const data = {
      name: v.name,
      channel: v.channel,
      segmentId: segment.id,
      subject: v.channel === "EMAIL" ? v.subject! : null,
      body: v.body,
      skipIfMessagedWithinDays: v.skipIfMessagedWithinDays ?? null,
      attributionDays: v.attributionDays,
    };
    if (campaignId) {
      if (!isUuid(campaignId)) throw notFound("Campaign");
      const moved = await tx.campaign.updateMany({
        where: { organizationId: ctx.organizationId, id: campaignId, status: "DRAFT" },
        data,
      });
      if (!moved.count)
        throw businessRuleViolation("CAMPAIGN_NOT_DRAFT", "Only a draft can change");
      await audit(tx, ctx, campaignId, "updated", { name: v.name, channel: v.channel });
      return { id: campaignId };
    }
    const c = await tx.campaign.create({
      data: { organizationId: ctx.organizationId, ...data, createdByUserId: ctx.userId },
      select: { id: true },
    });
    await audit(tx, ctx, c.id, "created", {
      name: v.name,
      channel: v.channel,
      segmentId: segment.id,
    });
    return c;
  });
}

async function loadCampaign(tx: Tx, ctx: TenantContext, campaignId: string) {
  if (!isUuid(campaignId)) throw notFound("Campaign");
  const c = await tx.campaign.findFirst({
    where: { organizationId: ctx.organizationId, id: campaignId },
    include: { segment: { select: { id: true, name: true } } },
  });
  if (!c) throw notFound("Campaign");
  return c;
}

/** Results: recipients by status, opt-outs, and guests who came back within the attribution window. */
async function resultsInTx(tx: Tx, ctx: TenantContext, c: { id: string; attributionDays: number }) {
  const recipients = await tx.campaignRecipient.findMany({
    where: { organizationId: ctx.organizationId, campaignId: c.id },
    select: { customerId: true, status: true, sentAt: true, optedOutAt: true },
  });
  const sent = recipients.filter((r) => r.status === "SENT" && r.sentAt);
  let returned = 0;
  let orders = 0;
  let revenue = new Decimal(0);
  for (const r of sent) {
    const until = new Date(r.sentAt!.getTime() + c.attributionDays * 86_400_000);
    const rows = await tx.posOrder.findMany({
      where: {
        organizationId: ctx.organizationId,
        customerId: r.customerId,
        status: "PAID",
        createdAt: { gte: r.sentAt!, lte: until },
      },
      select: { grossAmount: true, refundedAmount: true },
    });
    if (rows.length) returned += 1;
    orders += rows.length;
    for (const o of rows)
      revenue = revenue.plus(o.grossAmount.toString()).minus(o.refundedAmount.toString());
  }
  const count = (s: string) => recipients.filter((r) => r.status === s).length;
  return {
    total: recipients.length,
    pending: count("PENDING"),
    sent: count("SENT"),
    failed: count("FAILED"),
    skipped: count("SKIPPED"),
    optedOut: recipients.filter((r) => r.optedOutAt).length,
    returned,
    orders,
    revenue,
    returnRate: sent.length ? new Decimal(returned).div(sent.length) : null,
  };
}

export async function getCampaign(ctx: TenantContext, campaignId: string) {
  assertPermission(ctx.grants, "customers.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCampaign(tx, ctx, campaignId);
    const provider = await providerFor(ctx.organizationId, c.channel);
    const audience = c.status === "DRAFT" ? await audienceInTx(tx, ctx, c) : null;
    // A sample of the message as a guest called Sara would get it, unsubscribe link included.
    const sample = withUnsubscribe(
      c.channel,
      render(c.body, { name: "Sara" }),
      unsubscribeUrl("00000000-0000-7000-8000-000000000000"),
      UNSUBSCRIBE_LABEL,
    );
    return {
      ...c,
      audience: audience && {
        inSegment: audience.inSegment,
        consenting: audience.consenting,
        reachable: audience.reachable,
        recentlyMessaged: audience.recentlyMessaged,
        willReceive: audience.send.length,
      },
      sample,
      sms: c.channel === "SMS" ? smsParts(sample) : null,
      provider: provider?.name ?? null,
      results: c.status === "DRAFT" ? null : await resultsInTx(tx, ctx, c),
      canEdit: c.status === "DRAFT" && hasPermission(ctx.grants, "customers.manage"),
      canLaunch: c.status === "DRAFT" && hasPermission(ctx.grants, "campaigns.send"),
      canCancel:
        (c.status === "DRAFT" || c.status === "SCHEDULED") &&
        hasPermission(ctx.grants, "customers.manage"),
    };
  });
}

export async function listCampaigns(ctx: TenantContext) {
  assertPermission(ctx.grants, "customers.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.campaign.findMany({
      where: { organizationId: ctx.organizationId },
      include: { segment: { select: { name: true } }, _count: { select: { recipients: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return { campaigns: rows, canManage: hasPermission(ctx.grants, "customers.manage") };
  });
}

/**
 * Fix the recipients and schedule sending (now, or at a later time). Needs a
 * provider connected for the channel; there is none until one has been
 * added and tested (ADR-119).
 */
export async function launchCampaign(
  ctx: TenantContext,
  campaignId: string,
  rawInput: unknown = {},
) {
  if (!hasPermission(ctx.grants, "campaigns.send")) throw forbidden();
  const parsed = z
    .object({
      scheduledAt: z
        .string()
        .optional()
        .transform((v) => (v && v.trim() ? new Date(v) : undefined))
        .refine((d) => d === undefined || !Number.isNaN(d.getTime()), { error: "invalidDate" }),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCampaign(tx, ctx, campaignId);
    if (c.status !== "DRAFT")
      throw businessRuleViolation("CAMPAIGN_NOT_DRAFT", "Only a draft can be launched");
    if (!(await providerFor(ctx.organizationId, c.channel)))
      throw businessRuleViolation(
        "CHANNEL_NOT_CONNECTED",
        "No provider is connected for this channel",
        { channel: c.channel },
      );
    const audience = await audienceInTx(tx, ctx, c);
    if (audience.send.length === 0)
      throw businessRuleViolation("CAMPAIGN_NO_AUDIENCE", "Nobody in the segment can be reached");
    await tx.campaignRecipient.createMany({
      data: [
        ...audience.send.map((customerId) => ({
          organizationId: ctx.organizationId,
          campaignId: c.id,
          customerId,
        })),
        ...audience.skipped.map((customerId) => ({
          organizationId: ctx.organizationId,
          campaignId: c.id,
          customerId,
          status: "SKIPPED" as const,
          skipReason: "RECENTLY_MESSAGED",
        })),
      ],
    });
    const moved = await tx.campaign.updateMany({
      where: { organizationId: ctx.organizationId, id: c.id, status: "DRAFT" },
      data: {
        status: "SCHEDULED",
        scheduledAt: parsed.data.scheduledAt ?? new Date(),
        launchedAt: new Date(),
        launchedByUserId: ctx.userId,
      },
    });
    if (!moved.count) throw conflict("The campaign changed meanwhile");
    await audit(tx, ctx, c.id, "launched", {
      recipients: audience.send.length,
      skipped: audience.skipped.length,
    });
    return { recipients: audience.send.length, skipped: audience.skipped.length };
  });
}

export async function cancelCampaign(ctx: TenantContext, campaignId: string) {
  assertPermission(ctx.grants, "customers.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCampaign(tx, ctx, campaignId);
    const moved = await tx.campaign.updateMany({
      where: {
        organizationId: ctx.organizationId,
        id: c.id,
        status: { in: ["DRAFT", "SCHEDULED"] },
      },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    if (!moved.count)
      throw businessRuleViolation("CAMPAIGN_ALREADY_SENDING", "It is already being sent");
    await tx.campaignRecipient.updateMany({
      where: { organizationId: ctx.organizationId, campaignId: c.id, status: "PENDING" },
      data: { status: "SKIPPED", skipReason: "CANCELLED" },
    });
    await audit(tx, ctx, c.id, "cancelled", {});
  });
}

// ─── Sending (a job, ADR-087) ───

/**
 * Send what is due: scheduled campaigns whose time has come, a batch of
 * recipients at a time. Consent and erasure are checked again for each
 * guest at the moment of sending. Counts only.
 */
export async function sendDueCampaigns(options: { now?: Date; batch?: number } = {}) {
  const now = options.now ?? new Date();
  const due = await withSystemTx((tx) =>
    tx.campaign.findMany({
      where: { status: { in: ["SCHEDULED", "SENDING"] }, scheduledAt: { lte: now } },
      select: { id: true, organizationId: true, channel: true, subject: true, body: true },
      take: 20,
    }),
  );
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of due) {
    const provider = await providerFor(c.organizationId, c.channel);
    if (!provider) continue; // left waiting; shown on the campaign
    await withTenantTx(c.organizationId, (tx) =>
      tx.campaign.updateMany({
        where: { id: c.id, status: "SCHEDULED" },
        data: { status: "SENDING" },
      }),
    );
    const pending = await withTenantTx(c.organizationId, (tx) =>
      tx.campaignRecipient.findMany({
        where: { organizationId: c.organizationId, campaignId: c.id, status: "PENDING" },
        include: {
          customer: {
            select: {
              name: true,
              phone: true,
              email: true,
              marketingConsent: true,
              erasedAt: true,
            },
          },
        },
        take: options.batch ?? 200,
      }),
    );
    for (const r of pending) {
      const to = contactOf(c.channel, r.customer);
      if (r.customer.erasedAt || !r.customer.marketingConsent || !to) {
        await withTenantTx(c.organizationId, (tx) =>
          tx.campaignRecipient.update({
            where: { id: r.id },
            data: {
              status: "SKIPPED",
              skipReason: r.customer.marketingConsent ? "NO_CONTACT" : "NO_CONSENT",
            },
          }),
        );
        skipped += 1;
        continue;
      }
      const text = withUnsubscribe(
        c.channel,
        render(c.body, r.customer),
        unsubscribeUrl(r.id),
        UNSUBSCRIBE_LABEL,
      );
      try {
        const res = await provider.send({ to, subject: c.subject ?? undefined, text });
        await withTenantTx(c.organizationId, (tx) =>
          tx.campaignRecipient.update({
            where: { id: r.id },
            data: { status: "SENT", sentAt: new Date(), providerMessageId: res.providerMessageId },
          }),
        );
        sent += 1;
      } catch (error) {
        await withTenantTx(c.organizationId, (tx) =>
          tx.campaignRecipient.update({
            where: { id: r.id },
            data: {
              status: "FAILED",
              error: String((error as Error).message ?? error).slice(0, 300),
            },
          }),
        );
        failed += 1;
      }
    }
    const left = await withTenantTx(c.organizationId, (tx) =>
      tx.campaignRecipient.count({
        where: { organizationId: c.organizationId, campaignId: c.id, status: "PENDING" },
      }),
    );
    if (left === 0)
      await withTenantTx(c.organizationId, (tx) =>
        tx.campaign.updateMany({
          where: { id: c.id, status: "SENDING" },
          data: { status: "SENT", completedAt: new Date() },
        }),
      );
  }
  return { sent, failed, skipped };
}

// ─── Unsubscribe (public) ───

async function recipientForToken(token: string) {
  const id = verify(token);
  if (!id) return null;
  return withSystemTx((tx) =>
    tx.campaignRecipient.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        customerId: true,
        optedOutAt: true,
        customer: { select: { marketingConsent: true, erasedAt: true } },
        organization: { select: { name: true } },
      },
    }),
  );
}

export async function unsubscribePage(token: string) {
  const r = await recipientForToken(token);
  if (!r) return null;
  return {
    organizationName: r.organization.name,
    done: Boolean(r.optedOutAt) || !r.customer.marketingConsent,
  };
}

/** The guest stops all offers from this organization: consent withdrawn, audited. */
export async function unsubscribe(token: string) {
  const r = await recipientForToken(token);
  if (!r) throw notFound("Link");
  await withTenantTx(r.organizationId, async (tx) => {
    const now = new Date();
    await tx.posCustomer.update({
      where: { id: r.customerId },
      // consent_at records when consent was given; the withdrawal is on the recipient and in the audit log.
      data: { marketingConsent: false, consentAt: null },
    });
    await tx.campaignRecipient.update({
      where: { id: r.id },
      data: { optedOutAt: r.optedOutAt ?? now },
    });
    await recordAudit(
      tx,
      { organizationId: r.organizationId, userId: null },
      {
        action: "customer.consent_withdrawn",
        entityType: "pos_customer",
        entityId: r.customerId,
        changes: { via: "campaign_unsubscribe" },
      },
    );
  });
}
