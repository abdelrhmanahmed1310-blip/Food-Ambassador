import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import { SALES_CHANNELS } from "@/modules/menu/rules";
import { requiredText, uuidSchema } from "@/modules/shared/schemas";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { consumeRateLimit } from "@/server/rate-limit";
import { lineStatusesInTx } from "./kitchen";
import { normalizePhone } from "./loyalty-rules";
import { priceLinesInTx, sellableMenu } from "./service";
import { addTabLines, cancelTab, getTab, openTab, sendTab } from "./tables";

/**
 * Online ordering and self-order kiosks (DECISIONS.md ADR-070). A channel
 * is a public page for one branch (an unguessable address). A guest's order
 * becomes a named check at the branch: staff accept it (it goes to the
 * kitchen) or reject it, and the guest pays at the counter like any check.
 * Prices always come from the server. The guest follows the order on a
 * status page of its own (another unguessable address).
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const token = () => randomBytes(24).toString("base64url");
const TOKEN = /^[A-Za-z0-9_-]{24,64}$/;

const channelSchema = z
  .object({
    kind: z.enum(["WEB", "KIOSK"], { error: "invalidOption" }),
    name: requiredText(120),
    branchId: uuidSchema,
    channels: z
      .array(z.enum(SALES_CHANNELS, { error: "invalidOption" }))
      .min(1, { error: "required" }),
    autoSend: z
      .union([z.literal("on"), z.literal("true"), z.boolean(), z.literal("")])
      .optional()
      .transform((v) => v === true || v === "on" || v === "true"),
    maxOrderTotal: z
      .union([decimalString({ maxScale: 2, min: "1", max: "100000" }), z.literal("")])
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .refine((v) => v.kind === "KIOSK" || v.channels.every((c) => c !== "DINE_IN"), {
    error: "webNoDineIn",
    path: ["channels"],
  });

/** A web ordering page or a kiosk for one branch; orders are placed as its creator. */
export async function createOrderingChannel(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "pos.manage");
  const parsed = channelSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { organizationId: ctx.organizationId, id: v.branchId, archivedAt: null },
    });
    if (!branch) throw notFound("Branch");
    if (!hasPermission(ctx.grants, "pos.tables", { branchId: branch.id }))
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
    if (!floor)
      throw businessRuleViolation("ORDERING_NEEDS_FLOOR", "Set up a floor at this branch first", {
        field: "branchId",
      });
    const c = await tx.orderingChannel.create({
      data: {
        organizationId: ctx.organizationId,
        kind: v.kind,
        name: v.name,
        branchId: branch.id,
        channels: [...new Set(v.channels)],
        autoSend: v.autoSend,
        maxOrderTotal: v.maxOrderTotal,
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

/** The channel behind a public address and the context its orders run in, or null. */
async function resolveChannel(publicToken: string) {
  if (!TOKEN.test(publicToken)) return null;
  const c = await withSystemTx((tx) =>
    tx.orderingChannel.findUnique({
      where: { publicToken },
      include: {
        organization: { select: { slug: true, name: true } },
        branch: { select: { name: true, timeZone: true, archivedAt: true } },
      },
    }),
  );
  if (!c || c.archivedAt || c.branch.archivedAt) return null;
  // Act as the person who set the channel up, with their current access.
  const ctx = await withSystemTx((tx) =>
    resolveTenantContext(tx, c.createdByUserId, c.organization.slug),
  );
  if (!ctx || !hasPermission(ctx.grants, "pos.tables", { branchId: c.branchId })) return null;
  return { channel: c, ctx };
}

/** What a guest sees: the branch, and per allowed channel the items on sale with prices. */
export async function publicMenu(publicToken: string) {
  const r = await resolveChannel(publicToken);
  if (!r) return null;
  const { channel: c, ctx } = r;
  const date = businessDate(c.branch.timeZone ?? ctx.timeZone);
  const menus = await sellableMenu(ctx, c.branchId, date);
  return {
    kind: c.kind,
    name: c.name,
    organizationName: c.organization.name,
    branchName: c.branch.name,
    currency: ctx.baseCurrency,
    maxOrderTotal: c.maxOrderTotal ? dec(c.maxOrderTotal).toFixed() : null,
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

/**
 * Place a guest's order. Rate limited per address and per channel; the web
 * needs a phone number (to call the guest), a kiosk does not.
 */
export async function placeGuestOrder(publicToken: string, rawInput: unknown, clientIp: string) {
  const r = await resolveChannel(publicToken);
  if (!r) throw notFound("Ordering page");
  const { channel: c, ctx } = r;
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
  if (!c.channels.includes(v.channel))
    throw validationFailed(
      new z.ZodError([
        { code: "custom", path: ["channel"], message: "invalidOption", input: v.channel },
      ]),
    );
  const phone = v.phone ? normalizePhone(v.phone) : null;
  if (c.kind === "WEB" && !phone)
    throw validationFailed(
      new z.ZodError([
        { code: "custom", path: ["phone"], message: "invalidPhone", input: v.phone },
      ]),
    );
  // A resend of the same order returns it.
  const existing = await withTenantTx(ctx.organizationId, (tx) =>
    tx.posTab.findFirst({
      where: { organizationId: ctx.organizationId, sourceChannelId: c.id, sourceKey: v.key },
      select: { id: true, number: true, guestToken: true },
    }),
  );
  if (existing) return { ...existing, guestToken: existing.guestToken!, duplicate: true };
  const lines = v.lines.map((l) => ({
    itemId: l.itemId,
    quantity: String(l.quantity),
    optionIds: l.optionIds,
  }));
  // Price first (items on sale, options, VAT) so a refused order leaves nothing behind.
  const total = await withTenantTx(ctx.organizationId, async (tx) => {
    const priced = await priceLinesInTx(tx, ctx, {
      lines,
      channel: v.channel,
      branchId: c.branchId,
      date: businessDate(c.branch.timeZone ?? ctx.timeZone),
      asOf: new Date(),
    });
    return priced.lines.reduce((a, l) => a.plus(l.grossAmount), new Decimal(0));
  });
  if (c.maxOrderTotal && total.gt(dec(c.maxOrderTotal)))
    throw businessRuleViolation(
      "GUEST_ORDER_TOO_LARGE",
      "This order is larger than this page takes",
      {
        maximum: dec(c.maxOrderTotal).toFixed(),
      },
    );
  const guestToken = token();
  const tab = await openTab(
    ctx,
    {
      branchId: c.branchId,
      label: `${c.kind === "WEB" ? "Web" : "Kiosk"} · ${v.name}`.slice(0, 60),
      guests: 1,
    },
    {
      source: c.kind,
      channelId: c.id,
      key: v.key,
      channel: v.channel,
      guestName: v.name,
      guestPhone: phone,
      guestToken,
    },
  );
  try {
    await addTabLines(ctx, tab.id, {
      lines: lines.map((l, i) => ({ ...l, ...(i === 0 && v.note ? { note: v.note } : {}) })),
    });
    if (c.autoSend) await sendTab(ctx, tab.id);
  } catch (error) {
    await cancelTab(ctx, tab.id, { reason: "The order could not be placed" }).catch(
      () => undefined,
    );
    throw error;
  }
  return { id: tab.id, number: tab.number, guestToken, duplicate: false };
}

export type GuestOrderState = "RECEIVED" | "PREPARING" | "READY" | "COLLECTED" | "CANCELLED";

/** The guest's view of their order, by its own unguessable address. */
export async function guestOrderStatus(guestToken: string) {
  if (!TOKEN.test(guestToken)) return null;
  const found = await withSystemTx((tx) =>
    tx.posTab.findUnique({
      where: { guestToken },
      select: {
        id: true,
        organizationId: true,
        organization: { select: { name: true, baseCurrency: true } },
        branch: { select: { name: true } },
      },
    }),
  );
  if (!found) return null;
  return withTenantTx(found.organizationId, async (tx) => {
    const tab = await tx.posTab.findUniqueOrThrow({
      where: { id: found.id },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    const kitchen = await lineStatusesInTx(
      tx,
      { organizationId: found.organizationId } as TenantContext,
      tab.id,
    );
    const live = tab.lines.filter((l) => l.status !== "VOIDED");
    let state: GuestOrderState;
    if (tab.status === "CANCELLED") state = "CANCELLED";
    else if (tab.status === "CLOSED") state = "COLLECTED";
    else if (live.length === 0 || live.some((l) => l.status === "PENDING")) state = "RECEIVED";
    else if (live.every((l) => kitchen.get(l.id) === "READY")) state = "READY";
    else state = "PREPARING";
    return {
      number: tab.number,
      state,
      guestName: tab.guestName,
      organizationName: found.organization.name,
      branchName: found.branch.name,
      items: live.map((l) => ({ name: l.name, quantity: dec(l.quantity).toFixed() })),
      cancelReason: tab.status === "CANCELLED" ? tab.cancelReason : null,
    };
  });
}

// ─── Staff ───

/** Open guest orders at the branches the user serves: new ones first. */
export async function listGuestOrders(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const tabs = await tx.posTab.findMany({
      where: { organizationId: ctx.organizationId, source: { not: "STAFF" }, status: "OPEN" },
      include: {
        lines: { where: { status: { not: "VOIDED" } }, orderBy: { lineNo: "asc" } },
        sourceChannel: { select: { name: true, kind: true } },
      },
      orderBy: { openedAt: "asc" },
      take: 200,
    });
    const visible = tabs.filter((t) =>
      hasPermission(ctx.grants, "pos.tables", { branchId: t.branchId }),
    );
    const out = [];
    for (const t of visible) {
      const kitchen = await lineStatusesInTx(tx, ctx, t.id);
      const pending = t.lines.some((l) => l.status === "PENDING");
      const ready = !pending && t.lines.every((l) => kitchen.get(l.id) === "READY");
      out.push({
        id: t.id,
        number: t.number,
        source: t.source,
        channelName: t.sourceChannel?.name ?? "",
        channel: t.channel,
        guestName: t.guestName,
        guestPhone: t.guestPhone,
        openedAt: t.openedAt,
        state: pending ? ("NEW" as const) : ready ? ("READY" as const) : ("PREPARING" as const),
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

/** Accept: the order goes to the kitchen. */
export async function acceptGuestOrder(ctx: TenantContext, tabId: string) {
  await guestTab(ctx, tabId);
  return sendTab(ctx, tabId);
}

/** Reject with a reason the guest sees on their status page. */
export async function rejectGuestOrder(ctx: TenantContext, tabId: string, rawInput: unknown) {
  await guestTab(ctx, tabId);
  return cancelTab(ctx, tabId, rawInput);
}

async function guestTab(ctx: TenantContext, tabId: string) {
  const tab = await getTab(ctx, tabId);
  const row = await withTenantTx(ctx.organizationId, (tx) =>
    tx.posTab.findFirst({
      where: { organizationId: ctx.organizationId, id: tab.id },
      select: { source: true },
    }),
  );
  if (!row || row.source === "STAFF") throw notFound("Guest order");
}
