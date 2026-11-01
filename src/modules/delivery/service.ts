import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { encryptSecret, integrationKey, newSecret } from "@/modules/integrations/crypto";
import {
  verifyInbound,
  type InboundInput,
  type InboundResult,
} from "@/modules/integrations/service";
import { orderSchema, recordOrderInTx, voidOrder } from "@/modules/pos/service";
import { requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { AppError, businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { logger } from "@/server/logger";
import {
  DELIVERY_PLATFORMS,
  parseDeliveryBody,
  unmappedIds,
  type DeliveryPlatformKey,
} from "./adapters";
import type { PlacedOrder } from "./canonical";

/**
 * Delivery platform orders (DECISIONS.md ADR-069). One connector per
 * platform and branch receives signed orders (the inbound checks of
 * ADR-048), keeps them as delivery orders, and — accepted by the branch or
 * automatically — records each as a POS order on the connector's register:
 * the platform's prices, paid to the platform, to the kitchen, stock used,
 * VAT and ZATCA as any order.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const key = () => {
  const env = getEnv();
  return integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
};

export interface DeliveryConfig {
  platform: DeliveryPlatformKey;
  registerId: string;
  branchId: string;
  warehouseId: string;
  autoAccept: boolean;
}
const configOf = (c: { config: unknown }) => c.config as DeliveryConfig;

const connectorSchema = z.object({
  name: requiredText(120),
  platform: z.enum(DELIVERY_PLATFORMS, { error: "invalidOption" }),
  registerId: uuidSchema,
  autoAccept: z
    .union([z.literal("on"), z.literal("true"), z.boolean(), z.literal("")])
    .optional()
    .transform((v) => v === true || v === "on" || v === "true"),
});

/** A delivery connector; its URL and secret are given to the platform or middleware (secret once). */
export async function createDeliveryConnector(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "integrations.manage");
  const parsed = connectorSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  const secret = newSecret();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const register = await tx.posRegister.findFirst({
      where: { organizationId: ctx.organizationId, id: v.registerId, archivedAt: null },
    });
    if (!register) throw notFound("Register");
    // Orders are recorded as the connector's creator, so they must be able to sell there.
    if (
      !hasPermission(ctx.grants, "pos.sell", {
        branchId: register.branchId,
        warehouseId: register.warehouseId,
      })
    )
      throw businessRuleViolation(
        "DELIVERY_CREATOR_LACKS_ACCESS",
        "You cannot sell at this register",
        { field: "registerId" },
      );
    const config: DeliveryConfig = {
      platform: v.platform,
      registerId: register.id,
      branchId: register.branchId,
      warehouseId: register.warehouseId,
      autoAccept: v.autoAccept,
    };
    const c = await tx.connector.create({
      data: {
        organizationId: ctx.organizationId,
        kind: "DELIVERY_ORDERS",
        name: v.name,
        config: config as object,
        publicId: randomBytes(24).toString("base64url"),
        secretSealed: encryptSecret(secret, key()),
        secretHint: `…${secret.slice(-4)}`,
        createdByUserId: ctx.userId,
      },
      select: { id: true, publicId: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "connector.created",
      entityType: "connector",
      entityId: c.id,
      changes: { kind: "DELIVERY_ORDERS", name: v.name, config },
    });
    return { ...c, secret };
  });
}

const canSetUp = (ctx: TenantContext) =>
  hasPermission(ctx.grants, "integrations.manage") || hasPermission(ctx.grants, "menu.manage");

export async function listDeliveryConnectors(ctx: TenantContext) {
  if (!canSetUp(ctx)) assertPermission(ctx.grants, "integrations.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.connector.findMany({
      where: { organizationId: ctx.organizationId, kind: "DELIVERY_ORDERS" },
      select: {
        id: true,
        name: true,
        status: true,
        publicId: true,
        secretHint: true,
        config: true,
        _count: { select: { itemMaps: true, deliveryOrders: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({ ...r, config: configOf(r) }));
  });
}

async function loadConnector(tx: Tx, ctx: TenantContext, connectorId: string) {
  const id = uuidSchema.safeParse(connectorId);
  if (!id.success) throw notFound("Connector");
  const c = await tx.connector.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data, kind: "DELIVERY_ORDERS" },
  });
  if (!c) throw notFound("Connector");
  return c;
}

// ─── Item mapping ───

const mapSchema = z.object({
  kind: z.enum(["ITEM", "OPTION"], { error: "invalidOption" }),
  externalId: z.string().trim().min(1, { error: "required" }).max(100),
  targetId: uuidSchema,
});

/** Map a platform item (or modifier) id to our menu item (or option). */
export async function setDeliveryMap(ctx: TenantContext, connectorId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = mapSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadConnector(tx, ctx, connectorId);
    const target =
      v.kind === "ITEM"
        ? await tx.menuItem.findFirst({
            where: { organizationId: ctx.organizationId, id: v.targetId },
          })
        : await tx.modifierOption.findFirst({
            where: { organizationId: ctx.organizationId, id: v.targetId },
          });
    if (!target) throw notFound(v.kind === "ITEM" ? "Menu item" : "Modifier option");
    const m = await tx.deliveryItemMap.upsert({
      where: {
        connectorId_kind_externalId: { connectorId: c.id, kind: v.kind, externalId: v.externalId },
      },
      create: { organizationId: ctx.organizationId, connectorId: c.id, ...v },
      update: { targetId: v.targetId },
      select: { id: true },
    });
    // Orders waiting for this mapping can now be accepted.
    const waiting = await tx.deliveryOrder.findMany({
      where: { organizationId: ctx.organizationId, connectorId: c.id, status: "NEEDS_MAPPING" },
    });
    const maps = await mapsInTx(tx, ctx, c.id);
    for (const o of waiting) {
      const missing = unmappedIds(o.payload as PlacedOrder, maps);
      if (missing.items.length === 0 && missing.options.length === 0)
        await tx.deliveryOrder.update({
          where: { id: o.id },
          data: { status: "PENDING", problem: null },
        });
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "delivery_map.saved",
      entityType: "connector",
      entityId: c.id,
      changes: v,
    });
    return m;
  });
}

export async function removeDeliveryMap(ctx: TenantContext, mapId: string) {
  assertPermission(ctx.grants, "menu.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const m = await tx.deliveryItemMap.findFirst({
      where: { organizationId: ctx.organizationId, id: mapId },
    });
    if (!m) throw notFound("Mapping");
    await tx.deliveryItemMap.delete({ where: { id: m.id } });
  });
}

async function mapsInTx(tx: Tx, ctx: TenantContext, connectorId: string) {
  const rows = await tx.deliveryItemMap.findMany({
    where: { organizationId: ctx.organizationId, connectorId },
  });
  const by = (kind: string) =>
    new Map(rows.filter((r) => r.kind === kind).map((r) => [r.externalId, r.targetId]));
  const items = by("ITEM");
  const options = by("OPTION");
  return {
    items: new Set(items.keys()),
    options: new Set(options.keys()),
    itemOf: items,
    optionOf: options,
    rows,
  };
}

export async function deliveryMaps(ctx: TenantContext, connectorId: string) {
  if (!canSetUp(ctx)) assertPermission(ctx.grants, "menu.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadConnector(tx, ctx, connectorId);
    const maps = await mapsInTx(tx, ctx, c.id);
    // Ids seen on orders that still need a mapping.
    const waiting = await tx.deliveryOrder.findMany({
      where: { organizationId: ctx.organizationId, connectorId: c.id, status: "NEEDS_MAPPING" },
      select: { payload: true },
    });
    const missing = { items: new Map<string, string>(), options: new Map<string, string>() };
    for (const o of waiting) {
      const p = o.payload as PlacedOrder;
      for (const i of p.items) {
        if (!maps.items.has(i.externalId)) missing.items.set(i.externalId, i.name ?? "");
        for (const m of i.modifiers)
          if (!maps.options.has(m.externalId)) missing.options.set(m.externalId, m.name ?? "");
      }
    }
    return {
      connector: { id: c.id, name: c.name, config: configOf(c) },
      maps: maps.rows,
      missing: {
        items: [...missing.items].map(([externalId, name]) => ({ externalId, name })),
        options: [...missing.options].map(([externalId, name]) => ({ externalId, name })),
      },
    };
  });
}

// ─── Orders ───

const errorCode = (e: unknown) =>
  e instanceof AppError ? String(e.details?.rule ?? e.code) : "INTERNAL";

/** Record an accepted delivery order as a POS order (its id is the delivery order's: retry-safe). */
async function acceptInTx(
  tx: Tx,
  ctx: TenantContext,
  order: {
    id: string;
    platform: DeliveryPlatformKey;
    externalId: string;
    payload: unknown;
    displayCode: string | null;
    customerName: string | null;
  },
  config: DeliveryConfig,
  connectorId: string,
) {
  const p = order.payload as PlacedOrder;
  const maps = await mapsInTx(tx, ctx, connectorId);
  const missing = unmappedIds(p, maps);
  if (missing.items.length > 0 || missing.options.length > 0)
    throw businessRuleViolation(
      "DELIVERY_ITEMS_UNMAPPED",
      "Some items are not mapped to the menu",
      {
        items: missing.items.join(", "),
        options: missing.options.join(", "),
      },
    );
  if (p.items.some((i) => i.modifiers.some((m) => m.quantity > 1)))
    throw businessRuleViolation(
      "DELIVERY_MODIFIER_QUANTITY",
      "A modifier is ordered more than once",
    );
  const total = dec(p.total);
  const label = `${order.platform} ${order.displayCode ?? order.externalId}`.slice(0, 60);
  const input = orderSchema.parse({
    orderId: order.id,
    registerId: config.registerId,
    channel: "DELIVERY",
    lines: p.items.map((i) => ({
      itemId: maps.itemOf.get(i.externalId),
      quantity: String(i.quantity),
      optionIds: i.modifiers.map((m) => maps.optionOf.get(m.externalId)),
    })),
    // The payment line is replaced below: devices can never send a platform payment.
    payments: [],
    ...(dec(p.discount).gt(0)
      ? { discount: { kind: "AMOUNT", value: p.discount, reason: `${order.platform} discount` } }
      : {}),
    expectedTotal: total.toFixed(),
    note: [label, order.customerName, p.note].filter(Boolean).join(" · ").slice(0, 300),
  });
  const withPayment = {
    ...input,
    payments: total.gt(0)
      ? [
          {
            method: "DELIVERY_PLATFORM",
            amount: total.toFixed(),
            reference: `${order.platform.toLowerCase()}:${order.externalId}`.slice(0, 60),
          },
        ]
      : [],
  } as unknown as typeof input;
  try {
    return await recordOrderInTx(tx, ctx, withPayment, null, {
      unitPrices: p.items.map((i) => i.unitPrice),
      discountReason: `${order.platform} discount`,
      label,
    });
  } catch (error) {
    // The platform's total must be its items less its discount.
    if (error instanceof AppError && error.details?.rule === "ORDER_PRICES_CHANGED")
      throw businessRuleViolation(
        "DELIVERY_TOTAL_DIFFERS",
        "The order's total does not match its items",
        {
          total: p.total,
          items: String(error.details.total ?? ""),
        },
      );
    throw error;
  }
}

async function loadOrderForBranch(tx: Tx, ctx: TenantContext, id: string, lock = false) {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Delivery order");
  if (lock)
    await tx.$queryRaw`SELECT 1 FROM "delivery_orders" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${parsed.data}::uuid FOR UPDATE`;
  const o = await tx.deliveryOrder.findFirst({
    where: { organizationId: ctx.organizationId, id: parsed.data },
    include: { connector: true },
  });
  if (!o) throw notFound("Delivery order");
  const config = configOf(o.connector);
  if (
    !hasPermission(ctx.grants, "pos.sell", {
      branchId: config.branchId,
      warehouseId: config.warehouseId,
    })
  )
    throw notFound("Delivery order");
  return { order: o, config };
}

/** Accept a delivery order at the branch: it becomes a POS order and goes to the kitchen. */
export async function acceptDeliveryOrder(ctx: TenantContext, id: string) {
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const { order, config } = await loadOrderForBranch(tx, ctx, id, true);
      if (order.status === "ACCEPTED") return { posOrderId: order.posOrderId!, duplicate: true };
      if (order.status !== "PENDING" && order.status !== "NEEDS_MAPPING")
        throw businessRuleViolation("DELIVERY_ORDER_CLOSED", "This order is no longer open");
      const r = await acceptInTx(tx, ctx, order, config, order.connectorId);
      await tx.deliveryOrder.update({
        where: { id: order.id },
        data: {
          status: "ACCEPTED",
          posOrderId: r.id,
          decidedAt: new Date(),
          decidedByUserId: ctx.userId,
          problem: null,
        },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "delivery_order.accepted",
        entityType: "delivery_order",
        entityId: order.id,
        changes: { platform: order.platform, externalId: order.externalId, order: r.number },
      });
      return { posOrderId: r.id, number: r.number, duplicate: false };
    });
  } catch (error) {
    await noteProblem(ctx, id, error);
    throw error;
  }
}

/** Keep why an order could not be accepted (unmapped items move it to NEEDS_MAPPING). */
async function noteProblem(ctx: TenantContext, id: string, error: unknown) {
  const code = errorCode(error);
  await withTenantTx(ctx.organizationId, (tx) =>
    tx.deliveryOrder.updateMany({
      where: {
        organizationId: ctx.organizationId,
        id,
        status: { in: ["PENDING", "NEEDS_MAPPING"] },
      },
      data: {
        problem: code,
        ...(code === "DELIVERY_ITEMS_UNMAPPED" ? { status: "NEEDS_MAPPING" as const } : {}),
      },
    }),
  ).catch(() => undefined);
}

export async function rejectDeliveryOrder(ctx: TenantContext, id: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(200) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { order } = await loadOrderForBranch(tx, ctx, id, true);
    if (order.status !== "PENDING" && order.status !== "NEEDS_MAPPING")
      throw businessRuleViolation("DELIVERY_ORDER_CLOSED", "This order is no longer open");
    await tx.deliveryOrder.update({
      where: { id: order.id },
      data: {
        status: "REJECTED",
        decidedAt: new Date(),
        decidedByUserId: ctx.userId,
        problem: parsed.data.reason,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "delivery_order.rejected",
      entityType: "delivery_order",
      entityId: order.id,
      changes: { reason: parsed.data.reason },
    });
  });
}

const STATUSES = ["PENDING", "NEEDS_MAPPING", "ACCEPTED", "REJECTED", "CANCELLED"] as const;

/** Delivery orders of the branches the user sells at, newest first. */
export async function listDeliveryOrders(ctx: TenantContext, rawStatus?: unknown) {
  const status = z.enum(STATUSES).optional().catch(undefined).parse(rawStatus);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.deliveryOrder.findMany({
      where: { organizationId: ctx.organizationId, ...(status ? { status } : {}) },
      include: {
        connector: { select: { name: true, config: true } },
        posOrder: { select: { id: true, number: true } },
      },
      orderBy: { receivedAt: "desc" },
      take: 100,
    });
    return rows
      .filter((r) => {
        const c = configOf(r.connector);
        return hasPermission(ctx.grants, "pos.sell", {
          branchId: c.branchId,
          warehouseId: c.warehouseId,
        });
      })
      .map((r) => ({ ...r, payload: r.payload as PlacedOrder }));
  });
}

// ─── Inbound ───

/** POST /api/integrations/inbound/<publicId> for a delivery connector. */
export async function handleDeliveryInbound(input: InboundInput): Promise<InboundResult> {
  const v = await verifyInbound(input, "DELIVERY_ORDERS");
  if (!v.ok) return v.result;
  const { connector, ctx, log } = v;
  const config = configOf(connector);
  const parsed = parseDeliveryBody(config.platform, input.body);
  if (!parsed.ok) {
    await log("REJECTED", { error: "invalidBody" });
    return { status: 400, body: { error: "invalidBody" } };
  }
  const event = parsed.event;
  const org = connector.organizationId;
  if (event.event === "order.cancelled") {
    const outcome = await cancelFromPlatform(ctx, connector.id, event.order.id, event.order.reason);
    await log(outcome.status === 404 ? "REJECTED" : "ACCEPTED", outcome.body);
    return outcome;
  }
  const p = event.order;
  let created: { id: string; status: string };
  try {
    created = await withTenantTx(org, async (tx) => {
      const maps = await mapsInTx(tx, ctx, connector.id);
      const missing = unmappedIds(p, maps);
      const mapped = missing.items.length === 0 && missing.options.length === 0;
      // The stored order keeps no contact details: only what the kitchen and counter need.
      const { customerName, ...rest } = p;
      return tx.deliveryOrder.create({
        data: {
          organizationId: org,
          connectorId: connector.id,
          platform: config.platform,
          externalId: p.id,
          displayCode: p.displayCode ?? null,
          status: mapped ? "PENDING" : "NEEDS_MAPPING",
          payload: rest as object,
          total: p.total,
          customerName: customerName ?? null,
          placedAt: new Date(p.placedAt),
          problem: mapped ? null : "DELIVERY_ITEMS_UNMAPPED",
        },
        select: { id: true, status: true },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "delivery_orders_connector_id_external_id_key")) {
      const existing = await withTenantTx(org, (tx) =>
        tx.deliveryOrder.findFirstOrThrow({
          where: { organizationId: org, connectorId: connector.id, externalId: p.id },
          select: { id: true, status: true },
        }),
      );
      await log("DUPLICATE", { deliveryOrderId: existing.id });
      return {
        status: 200,
        body: { duplicate: true, deliveryOrderId: existing.id, status: existing.status },
      };
    }
    throw error;
  }
  let status = created.status;
  let problem: string | null = null;
  if (config.autoAccept && status === "PENDING") {
    try {
      await acceptDeliveryOrder(ctx, created.id);
      status = "ACCEPTED";
    } catch (error) {
      // Stays pending for the branch, with the reason.
      problem = errorCode(error);
      logger.warn("delivery order not auto-accepted", { deliveryOrderId: created.id, problem });
    }
  }
  const outcome = { deliveryOrderId: created.id, status, ...(problem ? { problem } : {}) };
  await log("ACCEPTED", outcome);
  return { status: 200, body: outcome };
}

/** The platform cancelled: an open order closes; a recorded one is voided if its shift is open. */
async function cancelFromPlatform(
  ctx: TenantContext,
  connectorId: string,
  externalId: string,
  reason: string | undefined,
): Promise<InboundResult> {
  const org = ctx.organizationId;
  const o = await withTenantTx(org, (tx) =>
    tx.deliveryOrder.findFirst({ where: { organizationId: org, connectorId, externalId } }),
  );
  if (!o) return { status: 404, body: { error: "orderNotFound" } };
  if (o.status === "CANCELLED" || o.status === "REJECTED")
    return { status: 200, body: { deliveryOrderId: o.id, status: o.status } };
  let problem: string | null = null;
  if (o.status === "ACCEPTED" && o.posOrderId) {
    try {
      await voidOrder(ctx, o.posOrderId, {
        reason: `Cancelled by ${o.platform}${reason ? `: ${reason}` : ""}`.slice(0, 500),
      });
    } catch (error) {
      // e.g. the shift is closed: a manager refunds it.
      problem = `VOID_NEEDED:${errorCode(error)}`;
    }
  }
  await withTenantTx(org, (tx) =>
    tx.deliveryOrder.update({
      where: { id: o.id },
      data: { status: "CANCELLED", problem: problem ?? reason?.slice(0, 200) ?? null },
    }),
  );
  return {
    status: 200,
    body: { deliveryOrderId: o.id, status: "CANCELLED", ...(problem ? { problem } : {}) },
  };
}

/** Menu items and options to map platform ids to. */
export async function mappingTargets(ctx: TenantContext) {
  assertPermission(ctx.grants, "menu.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [items, options] = await Promise.all([
      tx.menuItem.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
      tx.modifierOption.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, name: true, group: { select: { name: true } } },
        orderBy: { name: "asc" },
      }),
    ]);
    return { items, options };
  });
}
