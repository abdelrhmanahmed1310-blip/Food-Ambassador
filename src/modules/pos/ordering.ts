import "server-only";
import { contextForBranch } from "@/modules/fx/service";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import { SALES_CHANNELS } from "@/modules/menu/rules";
import type { Fetch } from "@/modules/payments/moyasar";
import {
  cancelPaymentLink,
  createPaymentLink,
  paymentProvider,
  refreshPaymentLink,
} from "@/modules/payments/links";
import { requiredText, uuidSchema } from "@/modules/shared/schemas";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { logger } from "@/server/logger";
import { consumeRateLimit } from "@/server/rate-limit";
import { applyDiscounts, promotionFor, saleMoment } from "./discounts";
import { lineStatusesInTx } from "./kitchen";
import { normalizePhone } from "./loyalty-rules";
import {
  guestState,
  isPickupSlot,
  ONLINE_PAYMENT_MINUTES,
  pickupSlots,
  releaseAt,
  type GuestState,
  type SlotRules,
} from "./pickup-rules";
import { loadPromotionsInTx, promotionForClient } from "./promotions";
import { priceLinesInTx, sellableMenu } from "./service";
import { addTabLines, cancelTab, getTab, openTab, sendTab } from "./tables";

/**
 * Online ordering and self-order kiosks (DECISIONS.md ADR-070, ADR-071). A
 * channel is a public page for one branch (an unguessable address). A
 * guest's order becomes a named check at the branch: paid at the counter, or
 * online before the kitchen starts; for as soon as possible or a pick-up
 * slot. Staff accept it (to the kitchen, or held until its slot), mark it
 * ready and handed over; kitchen screens mark it ready by themselves.
 * Prices always come from the server. The guest follows the order on a
 * status page of its own (another unguessable address).
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const token = () => randomBytes(24).toString("base64url");
const TOKEN = /^[A-Za-z0-9_-]{24,64}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const flag = z
  .union([z.literal("on"), z.literal("true"), z.boolean(), z.literal("")])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");
const optionalTime = z
  .union([z.string().regex(HHMM, { error: "invalid" }), z.literal("")])
  .optional()
  .transform((v) => (v ? v : null));

const channelSchema = z
  .object({
    // BOARD: a menu board on a screen; shows the menu, takes no orders (ADR-133).
    kind: z.enum(["WEB", "KIOSK", "BOARD"], { error: "invalidOption" }),
    name: requiredText(120),
    branchId: uuidSchema,
    channels: z
      .array(z.enum(SALES_CHANNELS, { error: "invalidOption" }))
      .min(1, { error: "required" }),
    autoSend: flag,
    maxOrderTotal: z
      .union([decimalString({ maxScale: 2, min: "1", max: "100000" }), z.literal("")])
      .optional()
      .transform((v) => (v ? v : null)),
    paymentMode: z
      .enum(["COUNTER", "ONLINE", "CHOICE"], { error: "invalidOption" })
      .default("COUNTER"),
    registerId: z
      .union([uuidSchema, z.literal("")])
      .optional()
      .transform((v) => (v ? v : null)),
    scheduling: flag,
    openFrom: optionalTime,
    openTo: optionalTime,
    slotMinutes: z.coerce
      .number()
      .int()
      .refine((v) => [5, 10, 15, 20, 30, 60].includes(v), { error: "invalid" })
      .default(15),
    leadMinutes: z.coerce
      .number()
      .int()
      .min(0, { error: "invalid" })
      .max(240, { error: "invalid" })
      .default(20),
    daysAhead: z.coerce
      .number()
      .int()
      .min(0, { error: "invalid" })
      .max(7, { error: "invalid" })
      .default(0),
    slotCapacity: z
      .union([
        z.coerce.number().int().min(1, { error: "invalid" }).max(500, { error: "invalid" }),
        z.literal(""),
      ])
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
  })
  .refine((v) => v.kind !== "WEB" || v.channels.every((c) => c !== "DINE_IN"), {
    error: "webNoDineIn",
    path: ["channels"],
  })
  .refine((v) => v.paymentMode === "COUNTER" || v.registerId, {
    error: "required",
    path: ["registerId"],
  })
  .refine((v) => !v.scheduling || (v.openFrom && v.openTo), {
    error: "required",
    path: ["openFrom"],
  });

/** A web ordering page or a kiosk for one branch; orders are placed as its creator. */
export async function createOrderingChannel(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "pos.manage");
  const parsed = channelSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const parsedValues = parsed.data;
  // A menu board takes no orders (ADR-133): no payments, kitchen sending or pick-up times.
  const board = parsedValues.kind === "BOARD";
  const v = board
    ? {
        ...parsedValues,
        paymentMode: "COUNTER" as const,
        autoSend: false,
        maxOrderTotal: null,
        registerId: null,
        scheduling: false,
      }
    : parsedValues;
  if (v.paymentMode !== "COUNTER" && !(await paymentProvider(ctx)))
    throw businessRuleViolation("PAYMENT_PROVIDER_MISSING", "Set up online payments first", {
      field: "paymentMode",
    });
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { organizationId: ctx.organizationId, id: v.branchId, archivedAt: null },
    });
    if (!branch) throw notFound("Branch");
    if (!board && !hasPermission(ctx.grants, "pos.tables", { branchId: branch.id }))
      throw businessRuleViolation(
        "ORDERING_CREATOR_LACKS_ACCESS",
        "You cannot open checks at this branch",
        {
          field: "branchId",
        },
      );
    // Guest orders are named checks: the branch needs a floor (its kitchen stock).
    const floor = await tx.posFloor.findFirst({
      where: { organizationId: ctx.organizationId, branchId: branch.id, archivedAt: null },
    });
    if (!floor && !board)
      throw businessRuleViolation("ORDERING_NEEDS_FLOOR", "Set up a floor at this branch first", {
        field: "branchId",
      });
    if (v.registerId) {
      // Online payments are recorded on this register's open shift, as its creator.
      const r = await tx.posRegister.findFirst({
        where: {
          organizationId: ctx.organizationId,
          id: v.registerId,
          branchId: branch.id,
          archivedAt: null,
        },
      });
      if (
        !r ||
        !hasPermission(ctx.grants, "pos.sell", { branchId: r.branchId, warehouseId: r.warehouseId })
      )
        throw notFound("Register");
    }
    const c = await tx.orderingChannel.create({
      data: {
        organizationId: ctx.organizationId,
        kind: v.kind,
        name: v.name,
        branchId: branch.id,
        channels: [...new Set(v.channels)],
        autoSend: v.autoSend,
        maxOrderTotal: v.maxOrderTotal,
        paymentMode: v.paymentMode,
        registerId: v.paymentMode === "COUNTER" ? null : v.registerId,
        scheduling: v.scheduling,
        openFrom: v.openFrom,
        openTo: v.openTo,
        slotMinutes: v.slotMinutes,
        leadMinutes: v.leadMinutes,
        daysAhead: v.daysAhead,
        slotCapacity: v.slotCapacity,
        publicToken: token(),
        createdByUserId: ctx.userId,
      },
      select: { id: true, publicToken: true, kind: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "ordering_channel.created",
      entityType: "ordering_channel",
      entityId: c.id,
      changes: { ...v },
    });
    return c;
  });
}

export async function listOrderingChannels(ctx: TenantContext) {
  assertPermission(ctx.grants, "pos.manage");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.orderingChannel.findMany({
      where: { organizationId: ctx.organizationId },
      include: { branch: { select: { code: true, name: true } } },
      orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { createdAt: "asc" }],
    }),
  );
}

export async function archiveOrderingChannel(ctx: TenantContext, channelId: string) {
  assertPermission(ctx.grants, "pos.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.orderingChannel.findFirst({
      where: { organizationId: ctx.organizationId, id: channelId },
    });
    if (!c) throw notFound("Ordering channel");
    if (c.archivedAt) return;
    await tx.orderingChannel.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
    await recordAudit(tx, actorOf(ctx), {
      action: "ordering_channel.archived",
      entityType: "ordering_channel",
      entityId: c.id,
      changes: { name: c.name },
    });
  });
}

// ─── Public pages (no sign-in) ───

type ChannelRow = NonNullable<Awaited<ReturnType<typeof findChannel>>>;

function findChannel(where: { publicToken: string } | { id: string }) {
  return withSystemTx((tx) =>
    tx.orderingChannel.findUnique({
      where,
      include: {
        organization: { select: { slug: true, name: true } },
        branch: { select: { name: true, timeZone: true, archivedAt: true } },
      },
    }),
  );
}

/** The context a channel's orders run in: its creator's current access, or null. */
async function channelContext(c: ChannelRow) {
  const ctx = await withSystemTx((tx) =>
    resolveTenantContext(tx, c.createdByUserId, c.organization.slug),
  );
  if (!ctx || !hasPermission(ctx.grants, "pos.tables", { branchId: c.branchId })) return null;
  return ctx;
}

/** The open channel behind a public address and its context, or null. */
async function resolveChannel(publicToken: string) {
  if (!TOKEN.test(publicToken)) return null;
  const c = await findChannel({ publicToken });
  if (!c || c.archivedAt || c.branch.archivedAt) return null;
  const ctx = await channelContext(c);
  return ctx ? { channel: c, ctx } : null;
}

const slotRules = (c: ChannelRow, ctx: TenantContext): SlotRules | null =>
  c.scheduling && c.openFrom && c.openTo
    ? {
        timeZone: c.branch.timeZone ?? ctx.timeZone,
        openFrom: c.openFrom,
        openTo: c.openTo,
        slotMinutes: c.slotMinutes,
        leadMinutes: c.leadMinutes,
        daysAhead: c.daysAhead,
      }
    : null;

/** "As soon as possible" is offered while the opening hours (if any) are on. */
function asapOpen(rules: SlotRules | null, now: Date) {
  if (!rules) return true;
  const t = saleMoment("DINE_IN", rules.timeZone, now).time;
  return rules.openFrom < rules.openTo
    ? t >= rules.openFrom && t < rules.openTo
    : t >= rules.openFrom || t < rules.openTo;
}

/** Orders per pick-up slot (not cancelled), for the kitchen's capacity. */
async function slotLoad(c: { id: string }, ctx: TenantContext, slots: Date[]) {
  if (slots.length === 0) return new Map<number, number>();
  const rows = await withTenantTx(ctx.organizationId, (tx) =>
    tx.posTab.groupBy({
      by: ["pickupAt"],
      where: {
        organizationId: ctx.organizationId,
        sourceChannelId: c.id,
        status: { notIn: ["CANCELLED", "MERGED"] },
        pickupAt: { in: slots },
      },
      _count: { _all: true },
    }),
  );
  return new Map(rows.map((r) => [r.pickupAt!.getTime(), r._count._all]));
}

/** The slots that still have room. */
async function openSlots(
  c: { id: string; slotCapacity: number | null },
  ctx: TenantContext,
  slots: Date[],
) {
  if (!c.slotCapacity) return slots;
  const load = await slotLoad(c, ctx, slots);
  return slots.filter((d) => (load.get(d.getTime()) ?? 0) < c.slotCapacity!);
}

/** What a guest sees: the branch, the items on sale with prices and promotions, pick-up times, how to pay. */
export async function publicMenu(publicToken: string) {
  const r = await resolveChannel(publicToken);
  if (!r) return null;
  const { channel: c } = r;
  // The page sells in the branch's company's currency (ADR-086).
  const ctx = await contextForBranch(r.ctx, c.branchId);
  const timeZone = c.branch.timeZone ?? ctx.timeZone;
  const now = new Date();
  const menus = await sellableMenu(ctx, c.branchId, businessDate(timeZone, now));
  const promotions = await withTenantTx(ctx.organizationId, (tx) =>
    loadPromotionsInTx(tx, ctx, now),
  );
  const rules = slotRules(c, ctx);
  return {
    kind: c.kind,
    name: c.name,
    organizationName: c.organization.name,
    branchName: c.branch.name,
    currency: ctx.baseCurrency,
    timeZone,
    maxOrderTotal: c.maxOrderTotal ? dec(c.maxOrderTotal).toFixed() : null,
    paymentMode: c.paymentMode,
    asap: asapOpen(rules, now),
    slots: rules
      ? (await openSlots(c, ctx, pickupSlots(now, rules))).map((d) => d.toISOString())
      : [],
    /** Applied as the server will when the order is paid (ADR-067). */
    promotions: promotions.map(promotionForClient),
    channels: menus.filter((m) => c.channels.includes(m.channel) && m.items.length > 0),
  };
}

export type PublicMenu = NonNullable<Awaited<ReturnType<typeof publicMenu>>>;

const guestOrderSchema = z.object({
  /** Generated by the guest's browser; a resend returns the same order. */
  key: uuidSchema,
  channel: z.enum(SALES_CHANNELS, { error: "invalidOption" }),
  name: z.string().trim().min(1, { error: "required" }).max(60, { error: "tooLong" }),
  phone: z.string().trim().max(30).optional().default(""),
  note: z.string().trim().max(200).optional(),
  /** A pick-up slot; none = as soon as possible. */
  pickupAt: z.iso.datetime({ offset: true }).optional(),
  payOnline: z.boolean().optional().default(false),
  lines: z
    .array(
      z.object({
        itemId: uuidSchema,
        quantity: z.coerce.number().int().min(1).max(20),
        optionIds: z.array(uuidSchema).max(20).default([]),
      }),
    )
    .min(1, { error: "required" })
    .max(30),
});

const fieldError = (path: string, message: string, input: unknown) =>
  validationFailed(new z.ZodError([{ code: "custom", path: [path], message, input }]));

const statusUrl = (guestToken: string) => `${getEnv().APP_URL}/order/status/${guestToken}`;

/**
 * Place a guest's order. Rate limited per address and per channel; the web
 * needs a phone number (to call the guest), a kiosk does not. With online
 * payment the guest is sent to the payment page; the kitchen starts only
 * once the payment is confirmed with the provider.
 */
export async function placeGuestOrder(
  publicToken: string,
  rawInput: unknown,
  clientIp: string,
  fetchImpl: Fetch = fetch,
) {
  const r = await resolveChannel(publicToken);
  // A menu board only shows the menu (ADR-133).
  if (!r || r.channel.kind === "BOARD") throw notFound("Ordering page");
  const { channel: c } = r;
  const ctx = await contextForBranch(r.ctx, c.branchId);
  const [byGuest, byChannel] = await Promise.all([
    consumeRateLimit(`guest-order:${c.id}:${clientIp}`, {
      window: 600,
      max: c.kind === "KIOSK" ? 60 : 5,
    }),
    consumeRateLimit(`guest-order:${c.id}`, { window: 600, max: 300 }),
  ]);
  if (!byGuest.allowed || !byChannel.allowed)
    throw businessRuleViolation("GUEST_ORDER_RATE_LIMITED", "Too many orders; try again later");
  const parsed = guestOrderSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  if (!c.channels.includes(v.channel)) throw fieldError("channel", "invalidOption", v.channel);
  const phone = v.phone ? normalizePhone(v.phone) : null;
  if (c.kind === "WEB" && !phone) throw fieldError("phone", "invalidPhone", v.phone);
  const payOnline = c.paymentMode === "ONLINE" || (c.paymentMode === "CHOICE" && v.payOnline);
  // Pick-up time: an offered slot, or as soon as possible while open.
  const now = new Date();
  const rules = slotRules(c, ctx);
  const pickupAt = v.pickupAt ? new Date(v.pickupAt) : null;
  if (pickupAt && (!rules || !isPickupSlot(pickupAt, now, rules)))
    throw businessRuleViolation("PICKUP_TIME_GONE", "This pick-up time is no longer available", {
      field: "pickupAt",
    });
  if (pickupAt && c.slotCapacity && (await openSlots(c, ctx, [pickupAt])).length === 0)
    throw businessRuleViolation("PICKUP_SLOT_FULL", "This pick-up time is full", {
      field: "pickupAt",
    });
  if (!pickupAt && !asapOpen(rules, now))
    throw businessRuleViolation("PICKUP_CLOSED_NOW", "Choose a pick-up time", {
      field: "pickupAt",
    });

  // A resend of the same order returns it.
  const existing = await withTenantTx(ctx.organizationId, (tx) =>
    tx.posTab.findFirst({
      where: { organizationId: ctx.organizationId, sourceChannelId: c.id, sourceKey: v.key },
      select: { id: true, number: true, guestToken: true },
    }),
  );
  if (existing)
    return { ...existing, guestToken: existing.guestToken!, paymentUrl: null, duplicate: true };
  const lines = v.lines.map((l) => ({
    itemId: l.itemId,
    quantity: String(l.quantity),
    optionIds: l.optionIds,
  }));
  // Price first (items on sale, options, VAT, promotions) so a refused order leaves nothing behind.
  const total = await withTenantTx(ctx.organizationId, async (tx) => {
    const priced = await priceLinesInTx(tx, ctx, {
      lines,
      channel: v.channel,
      branchId: c.branchId,
      date: businessDate(c.branch.timeZone ?? ctx.timeZone),
      asOf: now,
    });
    const promotions = await loadPromotionsInTx(tx, ctx, now);
    const categories = new Map(
      (
        await tx.menuItem.findMany({
          where: { organizationId: ctx.organizationId, id: { in: lines.map((l) => l.itemId) } },
          select: { id: true, categoryId: true },
        })
      ).map((i) => [i.id, i.categoryId]),
    );
    const moment = saleMoment(v.channel, c.branch.timeZone ?? ctx.timeZone, now);
    return applyDiscounts(
      priced.lines.map((l) => ({
        gross: dec(l.grossAmount),
        rate: l.taxRate === null ? null : dec(l.taxRate),
        promoPercent:
          promotionFor(
            { id: l.menuItemId, categoryId: categories.get(l.menuItemId)! },
            moment,
            promotions,
          )?.percent ?? null,
      })),
      null,
      ctx.baseCurrency,
    ).lines.reduce((a, l) => a.plus(l.gross), new Decimal(0));
  });
  if (c.maxOrderTotal && total.gt(dec(c.maxOrderTotal)))
    throw businessRuleViolation(
      "GUEST_ORDER_TOO_LARGE",
      "This order is larger than this page takes",
      {
        maximum: dec(c.maxOrderTotal).toFixed(),
      },
    );
  if (payOnline && !total.gt(0)) throw businessRuleViolation("NOTHING_TO_PAY", "Nothing to pay");
  const guestToken = token();
  const tab = await openTab(
    ctx,
    {
      branchId: c.branchId,
      label: `${c.kind === "WEB" ? "Web" : "Kiosk"} · ${v.name}`.slice(0, 60),
      guests: 1,
    },
    {
      source: c.kind as "WEB" | "KIOSK",
      channelId: c.id,
      key: v.key,
      channel: v.channel,
      guestName: v.name,
      guestPhone: phone,
      guestToken,
      payOnline,
      pickupAt,
    },
  );
  let paymentUrl: string | null = null;
  // The slot may have filled up meanwhile: counted with this order, it must still fit.
  if (pickupAt && c.slotCapacity) {
    const load = await slotLoad(c, ctx, [pickupAt]);
    if ((load.get(pickupAt.getTime()) ?? 0) > c.slotCapacity) {
      await cancelTab(ctx, tab.id, { reason: "The pick-up time was full" }).catch(() => undefined);
      throw businessRuleViolation("PICKUP_SLOT_FULL", "This pick-up time is full", {
        field: "pickupAt",
      });
    }
  }
  try {
    await addTabLines(ctx, tab.id, {
      lines: lines.map((l, i) => ({ ...l, ...(i === 0 && v.note ? { note: v.note } : {}) })),
    });
    if (payOnline) {
      const link = await createPaymentLink(
        ctx,
        tab.id,
        { registerId: c.registerId, lines: [] },
        fetchImpl,
        {
          callbackUrl: statusUrl(guestToken),
          expiresAt: new Date(now.getTime() + ONLINE_PAYMENT_MINUTES * 60_000),
        },
      );
      paymentUrl = link.url;
    } else if (c.autoSend) await acceptInCtx(ctx, tab.id);
  } catch (error) {
    await cancelTab(ctx, tab.id, { reason: "The order could not be placed" }).catch(
      () => undefined,
    );
    throw error;
  }
  return { id: tab.id, number: tab.number, guestToken, paymentUrl, duplicate: false };
}

/** Accept: to the kitchen now, or held until its lead time before a later pick-up. */
async function acceptInCtx(ctx: TenantContext, tabId: string) {
  const tab = await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "pos_tabs" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${tabId}::uuid FOR UPDATE`;
    const t = await tx.posTab.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: tabId },
      include: { sourceChannel: { select: { leadMinutes: true } } },
    });
    if (!t.acceptedAt)
      await tx.posTab.update({ where: { id: t.id }, data: { acceptedAt: new Date() } });
    return t;
  });
  const hold =
    tab.pickupAt &&
    releaseAt(tab.pickupAt, tab.sourceChannel?.leadMinutes ?? 0).getTime() > Date.now();
  if (!hold) await sendTab(ctx, tabId, {}, { paidGuestOrder: true });
  return { held: Boolean(hold) };
}

/** Bring guest orders up to date: confirm or expire online payments, release held orders that are due. */
async function syncGuestOrdersInCtx(ctx: TenantContext, tabIds: string[], fetchImpl: Fetch) {
  if (tabIds.length === 0) return;
  const tabs = await withTenantTx(ctx.organizationId, (tx) =>
    tx.posTab.findMany({
      where: { organizationId: ctx.organizationId, id: { in: tabIds }, source: { not: "STAFF" } },
      include: {
        sourceChannel: { select: { autoSend: true, leadMinutes: true } },
        lines: { select: { status: true } },
        _count: { select: { orders: true } },
      },
    }),
  );
  const links = await withTenantTx(ctx.organizationId, (tx) =>
    tx.paymentLink.findMany({
      where: {
        organizationId: ctx.organizationId,
        tabId: { in: tabIds },
        status: { in: ["CREATED", "PAID"] },
      },
      orderBy: { createdAt: "desc" },
    }),
  );
  for (const t of tabs) {
    try {
      let paid = t._count.orders > 0;
      if (t.payOnline && !paid && t.status === "OPEN") {
        const link = links.find((l) => l.tabId === t.id);
        let linkStatus = link?.status;
        let problem: string | null = link?.problem ?? null;
        if (link) {
          // Only the provider's own answer counts, never the guest's return to the page.
          const after = await refreshPaymentLink(ctx, link.id, fetchImpl).catch((e) => {
            logger.warn("guest payment check failed", { tab: t.id, error: (e as Error).message });
            return null;
          });
          // Read back: a paid link that could not be recorded keeps its reason (ADR-066).
          const now = await withTenantTx(ctx.organizationId, (tx) =>
            tx.paymentLink.findUnique({
              where: { id: link.id },
              select: { status: true, problem: true },
            }),
          );
          linkStatus = after?.status ?? now?.status ?? linkStatus;
          problem = now?.problem ?? null;
          paid = linkStatus === "RECORDED";
        }
        const expired = Date.now() - t.openedAt.getTime() > ONLINE_PAYMENT_MINUTES * 60_000;
        // Paid at the provider but not recorded (no open shift, another amount): never expired — staff resolve it.
        if (!paid && expired && linkStatus !== "PAID" && !problem) {
          if (link && linkStatus === "CREATED")
            await cancelPaymentLink(ctx, link.id).catch(() => undefined);
          await cancelTab(ctx, t.id, { reason: "Not paid in time" });
          continue;
        }
        if (paid && t.sourceChannel?.autoSend && !t.acceptedAt) {
          await acceptInCtx(ctx, t.id);
          continue;
        }
      }
      // Held for a later pick-up: to the kitchen at its lead time.
      if (
        t.acceptedAt &&
        t.pickupAt &&
        t.lines.some((l) => l.status === "PENDING") &&
        releaseAt(t.pickupAt, t.sourceChannel?.leadMinutes ?? 0).getTime() <= Date.now()
      )
        await sendTab(ctx, t.id, {}, { paidGuestOrder: true });
    } catch (error) {
      logger.warn("guest order sync failed", { tab: t.id, error: (error as Error).message });
    }
  }
}

async function stateInTx(
  tx: Tx,
  ctx: Pick<TenantContext, "organizationId">,
  t: {
    id: string;
    status: "OPEN" | "CLOSED" | "CANCELLED" | "MERGED";
    payOnline: boolean;
    acceptedAt: Date | null;
    readyAt: Date | null;
    pickedUpAt: Date | null;
    lines: Array<{ id: string; status: string }>;
    _count: { orders: number };
  },
): Promise<GuestState> {
  const kitchen = await lineStatusesInTx(tx, ctx as TenantContext, t.id);
  const live = t.lines.filter((l) => l.status !== "VOIDED");
  const sent = live.filter((l) => l.status === "SENT");
  return guestState({
    status: t.status,
    payOnline: t.payOnline,
    paid: t._count.orders > 0,
    acceptedAt: t.acceptedAt,
    readyAt: t.readyAt,
    pickedUpAt: t.pickedUpAt,
    pendingLines: live.filter((l) => l.status === "PENDING").length,
    sentLines: sent.length,
    kitchenReady: sent.length > 0 && sent.every((l) => kitchen.get(l.id) === "READY"),
  });
}

/** The guest's view of their order, by its own unguessable address. */
export async function guestOrderStatus(guestToken: string, fetchImpl: Fetch = fetch) {
  if (!TOKEN.test(guestToken)) return null;
  const found = await withSystemTx((tx) =>
    tx.posTab.findUnique({
      where: { guestToken },
      select: { id: true, sourceChannelId: true, organizationId: true },
    }),
  );
  if (!found?.sourceChannelId) return null;
  const c = await findChannel({ id: found.sourceChannelId });
  const ctx = c ? await channelContext(c) : null;
  if (!c || !ctx) return null;
  await syncGuestOrdersInCtx(ctx, [found.id], fetchImpl);
  return withTenantTx(found.organizationId, async (tx) => {
    const tab = await tx.posTab.findUniqueOrThrow({
      where: { id: found.id },
      include: { lines: { orderBy: { lineNo: "asc" } }, _count: { select: { orders: true } } },
    });
    const state = await stateInTx(tx, ctx, tab);
    const link =
      state === "AWAITING_PAYMENT"
        ? await tx.paymentLink.findFirst({
            where: { organizationId: found.organizationId, tabId: tab.id, status: "CREATED" },
            orderBy: { createdAt: "desc" },
            select: { url: true },
          })
        : null;
    return {
      number: tab.number,
      state,
      guestName: tab.guestName,
      organizationName: c.organization.name,
      branchName: c.branch.name,
      timeZone: c.branch.timeZone ?? ctx.timeZone,
      pickupAt: tab.pickupAt,
      payOnline: tab.payOnline,
      paymentUrl: link?.url ?? null,
      items: tab.lines
        .filter((l) => l.status !== "VOIDED")
        .map((l) => ({ name: l.name, quantity: dec(l.quantity).toFixed() })),
      cancelReason: tab.status === "CANCELLED" ? tab.cancelReason : null,
    };
  });
}

// ─── Staff ───

/** Guest orders still to prepare or hand over at the branches the user serves; oldest first. */
export async function listGuestOrders(ctx: TenantContext, fetchImpl: Fetch = fetch) {
  const where = {
    organizationId: ctx.organizationId,
    source: { not: "STAFF" as const },
    OR: [
      { status: "OPEN" as const },
      // Paid online and not yet handed over (paid today or yesterday).
      {
        status: "CLOSED" as const,
        payOnline: true,
        pickedUpAt: null,
        closedAt: { gte: new Date(Date.now() - 36 * 3600_000) },
      },
    ],
  };
  const visibleIds = (
    await withTenantTx(ctx.organizationId, (tx) =>
      tx.posTab.findMany({ where, select: { id: true, branchId: true }, take: 300 }),
    )
  )
    .filter((t) => hasPermission(ctx.grants, "pos.tables", { branchId: t.branchId }))
    .map((t) => t.id);
  await syncGuestOrdersInCtx(ctx, visibleIds, fetchImpl);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const tabs = await tx.posTab.findMany({
      where: { ...where, id: { in: visibleIds } },
      include: {
        lines: { where: { status: { not: "VOIDED" } }, orderBy: { lineNo: "asc" } },
        sourceChannel: { select: { name: true, kind: true } },
        _count: { select: { orders: true } },
      },
      orderBy: [{ pickupAt: { sort: "asc", nulls: "first" } }, { openedAt: "asc" }],
    });
    // A payment taken online that could not be recorded needs a person (ADR-066).
    const problems = new Map(
      (
        await tx.paymentLink.findMany({
          where: {
            organizationId: ctx.organizationId,
            tabId: { in: tabs.map((t) => t.id) },
            problem: { not: null },
          },
          select: { tabId: true, problem: true },
        })
      ).map((l) => [l.tabId, l.problem]),
    );
    const out = [];
    for (const t of tabs) {
      const state = await stateInTx(tx, ctx, t);
      if (state === "CANCELLED" || state === "COLLECTED") continue;
      out.push({
        id: t.id,
        number: t.number,
        source: t.source,
        channelName: t.sourceChannel?.name ?? "",
        channel: t.channel,
        guestName: t.guestName,
        guestPhone: t.guestPhone,
        openedAt: t.openedAt,
        pickupAt: t.pickupAt,
        payOnline: t.payOnline,
        paid: t._count.orders > 0,
        paymentProblem: problems.get(t.id) ?? null,
        state,
        items: t.lines.map((l) => ({
          name: l.name,
          quantity: dec(l.quantity).toFixed(),
          note: l.note,
        })),
      });
    }
    return out;
  });
}

async function guestTabInTx(tx: Tx, ctx: TenantContext, tabId: string) {
  const tab = await getTab(ctx, tabId); // visible to this user?
  const row = await tx.posTab.findFirst({
    where: { organizationId: ctx.organizationId, id: tab.id },
    include: { _count: { select: { orders: true } } },
  });
  if (!row || row.source === "STAFF") throw notFound("Guest order");
  assertPermission(ctx.grants, "pos.tables", { branchId: row.branchId });
  return row;
}

/** Accept: the order goes to the kitchen (or waits for its pick-up slot). */
export async function acceptGuestOrder(ctx: TenantContext, tabId: string) {
  const t = await withTenantTx(ctx.organizationId, (tx) => guestTabInTx(tx, ctx, tabId));
  if (t.status === "CANCELLED") throw businessRuleViolation("CHECK_CLOSED", "This check is closed");
  if (t.payOnline && t._count.orders === 0)
    throw businessRuleViolation("GUEST_ORDER_NOT_PAID", "Wait for the online payment");
  return acceptInCtx(ctx, t.id);
}

/** Reject with a reason the guest sees. An order paid online is voided and refunded instead. */
export async function rejectGuestOrder(ctx: TenantContext, tabId: string, rawInput: unknown) {
  const t = await withTenantTx(ctx.organizationId, (tx) => guestTabInTx(tx, ctx, tabId));
  if (t._count.orders > 0)
    throw businessRuleViolation(
      "GUEST_ORDER_PAID",
      "This order is paid: void it and refund the payment",
    );
  const links = await withTenantTx(ctx.organizationId, (tx) =>
    tx.paymentLink.findMany({
      where: { organizationId: ctx.organizationId, tabId: t.id, status: "CREATED" },
    }),
  );
  for (const l of links) await cancelPaymentLink(ctx, l.id).catch(() => undefined);
  return cancelTab(ctx, t.id, rawInput);
}

/** Staff mark an order ready (where no kitchen screen does it). */
export async function markGuestReady(ctx: TenantContext, tabId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await guestTabInTx(tx, ctx, tabId);
    if (!t.acceptedAt)
      throw businessRuleViolation("GUEST_ORDER_NOT_ACCEPTED", "Accept the order first");
    if (t.status === "CANCELLED")
      throw businessRuleViolation("CHECK_CLOSED", "This check is closed");
    if (t.readyAt) return;
    await tx.posTab.update({ where: { id: t.id }, data: { readyAt: new Date() } });
    await recordAudit(tx, actorOf(ctx), {
      action: "pos_tab.guest_ready",
      entityType: "pos_tab",
      entityId: t.id,
      changes: {},
    });
  });
}

/** An order paid online is handed over to the guest. (One paid at the counter is handed over when paid.) */
export async function markGuestPickedUp(ctx: TenantContext, tabId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const t = await guestTabInTx(tx, ctx, tabId);
    if (!t.acceptedAt)
      throw businessRuleViolation("GUEST_ORDER_NOT_ACCEPTED", "Accept the order first");
    if (t._count.orders === 0)
      throw businessRuleViolation("GUEST_ORDER_NOT_PAID", "Take the payment first");
    if (t.pickedUpAt) return;
    await tx.posTab.update({
      where: { id: t.id },
      data: { pickedUpAt: new Date(), readyAt: t.readyAt ?? new Date(), guestPhone: null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "pos_tab.guest_picked_up",
      entityType: "pos_tab",
      entityId: t.id,
      changes: {},
    });
  });
}
