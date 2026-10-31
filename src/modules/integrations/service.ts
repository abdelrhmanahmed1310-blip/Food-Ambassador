import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { importSales } from "@/modules/sales/imports";
import { requiredText, uuidSchema } from "@/modules/shared/schemas";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { logger } from "@/server/logger";
import { consumeRateLimit } from "@/server/rate-limit";
import {
  decryptSecret,
  encryptSecret,
  integrationKey,
  newSecret,
  retryDelaySeconds,
  sign,
  urlProblem,
  verifySignature,
} from "./crypto";
import { postWebhook } from "./http";

/**
 * Integrations (DECISIONS.md ADR-048): connectors with encrypted secrets, a
 * signed inbound sales webhook in our own documented format, and outbound
 * event webhooks through a transactional outbox with retries. No third-party
 * connector is claimed until tested against the provider's sandbox.
 */

export const OUTBOUND_EVENTS = [
  "purchase_order.approved",
  "goods_receipt.posted",
  "sales_invoice.issued",
] as const;
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

const key = () => {
  const env = getEnv();
  return integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hint = (secret: string) => `…${secret.slice(-4)}`;

async function resolveAll(hostname: string): Promise<string[]> {
  try {
    return (await lookup(hostname, { all: true })).map((r) => r.address);
  } catch {
    return [];
  }
}

async function checkUrl(raw: string, field: string) {
  let host = "";
  try {
    host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  } catch {
    /* reported by urlProblem */
  }
  const problem = urlProblem(
    raw,
    host ? await resolveAll(host) : [],
    getEnv().INTEGRATIONS_ALLOW_PRIVATE_URLS,
  );
  if (problem)
    throw businessRuleViolation("WEBHOOK_URL_NOT_ALLOWED", "This address cannot be called", {
      field,
      reason: problem,
    });
}

// ─── Connectors ───

const createSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("INBOUND_SALES_WEBHOOK"),
    name: requiredText(120),
    warehouseId: uuidSchema,
  }),
  z.object({
    kind: z.literal("OUTBOUND_WEBHOOK"),
    name: requiredText(120),
    url: z.string().trim().min(1, { error: "required" }).max(500),
    events: z
      .array(z.enum(OUTBOUND_EVENTS, { error: "invalidOption" }))
      .min(1, { error: "required" }),
  }),
]);

/** Create a connector; the secret is returned this once and stored only encrypted. */
export async function createConnector(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "integrations.manage");
  const parsed = createSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  if (input.kind === "OUTBOUND_WEBHOOK") await checkUrl(input.url, "url");
  const secret = newSecret();
  return withTenantTx(ctx.organizationId, async (tx) => {
    let config: Record<string, unknown>;
    if (input.kind === "INBOUND_SALES_WEBHOOK") {
      const wh = await tx.warehouse.findFirst({
        where: { organizationId: ctx.organizationId, id: input.warehouseId, archivedAt: null },
        select: { id: true, branchId: true },
      });
      if (!wh) throw notFound("Warehouse");
      // The connector acts as its creator, so the creator must be able to import sales there.
      if (!hasPermission(ctx.grants, "sales.import", { branchId: wh.branchId, warehouseId: wh.id }))
        throw businessRuleViolation(
          "CONNECTOR_CREATOR_LACKS_ACCESS",
          "You cannot import sales into this warehouse",
          { field: "warehouseId" },
        );
      config = { warehouseId: wh.id };
    } else {
      config = { url: input.url, events: [...new Set(input.events)] };
    }
    const connector = await tx.connector.create({
      data: {
        organizationId: ctx.organizationId,
        kind: input.kind,
        name: input.name,
        config: config as object,
        publicId: randomBytes(24).toString("base64url"),
        secretSealed: encryptSecret(secret, key()),
        secretHint: hint(secret),
        createdByUserId: ctx.userId,
      },
      select: { id: true, publicId: true, kind: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "connector.created",
      entityType: "connector",
      entityId: connector.id,
      changes: { kind: input.kind, name: input.name, config },
    });
    return { ...connector, secret };
  });
}

export async function rotateConnectorSecret(ctx: TenantContext, connectorId: string) {
  assertPermission(ctx.grants, "integrations.manage");
  const secret = newSecret();
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.connector.findFirst({
      where: { organizationId: ctx.organizationId, id: connectorId },
    });
    if (!c) throw notFound("Connector");
    await tx.connector.update({
      where: { id: c.id },
      data: {
        secretSealed: encryptSecret(secret, key()),
        secretHint: hint(secret),
        secretRotatedAt: new Date(),
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "connector.secret_rotated",
      entityType: "connector",
      entityId: c.id,
      changes: {},
    });
  });
  return { secret };
}

export async function setConnectorStatus(
  ctx: TenantContext,
  connectorId: string,
  status: "ACTIVE" | "DISABLED",
) {
  assertPermission(ctx.grants, "integrations.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.connector.findFirst({
      where: { organizationId: ctx.organizationId, id: connectorId },
    });
    if (!c) throw notFound("Connector");
    await tx.connector.update({ where: { id: c.id }, data: { status } });
    await recordAudit(tx, actorOf(ctx), {
      action: `connector.${status === "ACTIVE" ? "enabled" : "disabled"}`,
      entityType: "connector",
      entityId: c.id,
      changes: {},
    });
  });
}

/** Retry a failed delivery now (it keeps its event id, so the receiver can deduplicate). */
export async function retryDelivery(ctx: TenantContext, deliveryId: string) {
  assertPermission(ctx.grants, "integrations.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await tx.outboundDelivery.findFirst({
      where: { organizationId: ctx.organizationId, id: deliveryId },
    });
    if (!d) throw notFound("Delivery");
    if (d.status === "DELIVERED")
      throw businessRuleViolation("DELIVERY_ALREADY_SENT", "Already delivered");
    await tx.outboundDelivery.update({
      where: { id: d.id },
      data: { status: "PENDING", nextAttemptAt: new Date() },
    });
  });
}

export async function listConnectors(ctx: TenantContext) {
  assertPermission(ctx.grants, "integrations.manage");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.connector.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        kind: true,
        name: true,
        status: true,
        config: true,
        publicId: true,
        secretHint: true,
        createdAt: true,
        secretRotatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  );
}

export async function getConnector(ctx: TenantContext, connectorId: string) {
  assertPermission(ctx.grants, "integrations.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.connector.findFirst({
      where: { organizationId: ctx.organizationId, id: connectorId },
      select: {
        id: true,
        kind: true,
        name: true,
        status: true,
        config: true,
        publicId: true,
        secretHint: true,
        createdAt: true,
        secretRotatedAt: true,
      },
    });
    if (!c) throw notFound("Connector");
    const [events, deliveries] = await Promise.all([
      tx.integrationEvent.findMany({
        where: { organizationId: ctx.organizationId, connectorId: c.id },
        orderBy: { receivedAt: "desc" },
        take: 50,
      }),
      tx.outboundDelivery.findMany({
        where: { organizationId: ctx.organizationId, connectorId: c.id },
        select: {
          id: true,
          eventType: true,
          eventKey: true,
          status: true,
          attempts: true,
          nextAttemptAt: true,
          lastStatusCode: true,
          lastError: true,
          deliveredAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return { ...c, events, deliveries };
  });
}

// ─── Outbound: transactional outbox ───

/**
 * Queue an event for every active outbound connector subscribed to it, in
 * the caller's transaction — so an event exists exactly when the business
 * change committed. Sent later by `deliverDueWebhooks`.
 */
export async function emitEvent(
  tx: Tx,
  ctx: TenantContext,
  type: OutboundEvent,
  entityId: string,
  data: Record<string, unknown>,
) {
  const connectors = await tx.connector.findMany({
    where: { organizationId: ctx.organizationId, kind: "OUTBOUND_WEBHOOK", status: "ACTIVE" },
    select: { id: true, config: true },
  });
  const subscribed = connectors.filter((c) =>
    ((c.config as { events?: string[] }).events ?? []).includes(type),
  );
  if (subscribed.length === 0) return;
  const eventKey = `${type}:${entityId}`;
  await tx.outboundDelivery.createMany({
    data: subscribed.map((c) => ({
      organizationId: ctx.organizationId,
      connectorId: c.id,
      eventType: type,
      eventKey,
      payload: { id: eventKey, type, occurredAt: new Date().toISOString(), data } as object,
    })),
    skipDuplicates: true,
  });
}

/**
 * Send due deliveries (system job, all organizations): signed POST, 10 s
 * timeout, no redirects, address re-checked at connect time; 2xx = delivered, else retry with backoff and fail
 * after the last attempt. Due rows are claimed with a 5-minute lease
 * (SKIP LOCKED) so two workers never send the same delivery at once.
 */
export async function deliverDueWebhooks(options: { limit?: number; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const due = await withSystemTx(
    (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "outbound_deliveries" SET "next_attempt_at" = ${new Date(now.getTime() + 5 * 60_000)}
      WHERE "id" IN (
        SELECT "id" FROM "outbound_deliveries"
        WHERE "status" = 'PENDING' AND "next_attempt_at" <= ${now}
        ORDER BY "next_attempt_at" LIMIT ${options.limit ?? 50}
        FOR UPDATE SKIP LOCKED)
      RETURNING "id"`,
  );
  const results: Array<{ id: string; status: "DELIVERED" | "PENDING" | "FAILED" }> = [];
  for (const { id } of due) {
    const d = await withSystemTx((tx) =>
      tx.outboundDelivery.findUniqueOrThrow({ where: { id }, include: { connector: true } }),
    );
    if (d.status !== "PENDING") continue;
    let statusCode: number | null = null;
    let error: string | null = null;
    if (d.connector.status !== "ACTIVE") error = "connectorDisabled";
    else {
      const url = (d.connector.config as { url: string }).url;
      try {
        await checkUrl(url, "url");
        const body = JSON.stringify(d.payload);
        const timestamp = String(Math.floor(now.getTime() / 1000));
        statusCode = await postWebhook(
          url,
          {
            "Content-Type": "application/json",
            "User-Agent": "FoodAmbassador-Webhooks/1",
            "X-FA-Event": d.eventType,
            "X-FA-Event-Id": d.eventKey,
            "X-FA-Timestamp": timestamp,
            "X-FA-Signature": sign(decryptSecret(d.connector.secretSealed, key()), timestamp, body),
          },
          body,
          { allowPrivate: getEnv().INTEGRATIONS_ALLOW_PRIVATE_URLS, timeoutMs: 10_000 },
        );
        if (statusCode < 200 || statusCode >= 300) error = `http ${statusCode}`;
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 300) : "error";
      }
    }
    const attempts = d.attempts + 1;
    const delay = retryDelaySeconds(attempts);
    const status = !error
      ? "DELIVERED"
      : delay === null || error === "connectorDisabled"
        ? "FAILED"
        : "PENDING";
    await withSystemTx((tx) =>
      tx.outboundDelivery.update({
        where: { id: d.id },
        data: {
          status,
          attempts,
          lastStatusCode: statusCode,
          lastError: error,
          deliveredAt: status === "DELIVERED" ? new Date() : null,
          nextAttemptAt:
            status === "PENDING"
              ? new Date(now.getTime() + (delay as number) * 1000)
              : d.nextAttemptAt,
        },
      }),
    );
    if (error) logger.warn("webhook delivery failed", { deliveryId: d.id, attempts, error });
    results.push({ id: d.id, status });
  }
  return results;
}

// ─── Inbound: sales webhook ───

const inboundLine = z.object({
  date: z.string(),
  external_id: z.string(),
  item_code: z.string(),
  item_type: z.string().optional(),
  quantity: z.union([z.string(), z.number()]),
  net_amount: z.union([z.string(), z.number()]).optional(),
  gross_amount: z.union([z.string(), z.number()]).optional(),
  tax_code: z.string().optional(),
  channel: z.string().optional(),
});
const inboundBody = z.object({ lines: z.array(inboundLine).min(1).max(5000) });

export interface InboundResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Handle POST /api/integrations/inbound/<publicId>. The body is verified
 * (HMAC over timestamp + body, 5-minute window), deduplicated by the
 * Idempotency-Key header, and posted through the normal sales import as the
 * connector's creator — with that person's current permissions.
 */
export async function handleInboundSales(input: {
  publicId: string;
  body: string;
  headers: { timestamp: string | null; signature: string | null; idempotencyKey: string | null };
}): Promise<InboundResult> {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(input.publicId))
    return { status: 404, body: { error: "notFound" } };
  // Looked up by an unguessable id before any tenant is known.
  const connector = await withSystemTx((tx) =>
    tx.connector.findUnique({
      where: { publicId: input.publicId },
      include: { organization: { select: { slug: true } } },
    }),
  );
  if (!connector || connector.kind !== "INBOUND_SALES_WEBHOOK")
    return { status: 404, body: { error: "notFound" } };
  const limit = await consumeRateLimit(`inbound:${connector.id}`, { window: 60, max: 120 });
  if (!limit.allowed)
    return { status: 429, body: { error: "rateLimited", retryAfter: limit.retryAfter } };
  const org = connector.organizationId;
  const log = (status: "ACCEPTED" | "REJECTED" | "DUPLICATE", outcome: Record<string, unknown>) =>
    withTenantTx(org, (tx) =>
      tx.integrationEvent.create({
        data: {
          organizationId: org,
          connectorId: connector.id,
          idempotencyKey: input.headers.idempotencyKey,
          status,
          outcome: outcome as object,
          bodySha256: sha256(input.body),
          bodyBytes: Buffer.byteLength(input.body),
        },
      }),
    );
  if (connector.status !== "ACTIVE") {
    await log("REJECTED", { error: "connectorDisabled" });
    return { status: 403, body: { error: "connectorDisabled" } };
  }
  const check = verifySignature({
    secret: decryptSecret(connector.secretSealed, key()),
    timestamp: input.headers.timestamp,
    signature: input.headers.signature,
    body: input.body,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (check !== "OK") {
    await log("REJECTED", { error: `signature${check}` });
    return { status: 401, body: { error: "invalidSignature", reason: check } };
  }
  const idem = input.headers.idempotencyKey;
  if (!idem || !/^[\w.:-]{8,120}$/.test(idem)) {
    await log("REJECTED", { error: "idempotencyKeyRequired" });
    return { status: 400, body: { error: "idempotencyKeyRequired" } };
  }
  const previous = await withTenantTx(org, (tx) =>
    tx.integrationEvent.findFirst({
      where: {
        organizationId: org,
        connectorId: connector.id,
        idempotencyKey: idem,
        status: "ACCEPTED",
      },
    }),
  );
  if (previous) {
    await log("DUPLICATE", { original: previous.id });
    return { status: 200, body: { duplicate: true, ...(previous.outcome as object) } };
  }
  let parsed: z.infer<typeof inboundBody>;
  try {
    const json = inboundBody.safeParse(JSON.parse(input.body));
    if (!json.success) throw new Error("format");
    parsed = json.data;
  } catch {
    await log("REJECTED", { error: "invalidBody" });
    return { status: 400, body: { error: "invalidBody" } };
  }
  // Act as the person who set the connector up, with their current access.
  const ctx = await withSystemTx((tx) =>
    resolveTenantContext(tx, connector.createdByUserId, connector.organization.slug),
  );
  if (!ctx) {
    await log("REJECTED", { error: "creatorNoAccess" });
    return { status: 403, body: { error: "creatorNoAccess" } };
  }
  const cols = [
    "date",
    "external_id",
    "item_code",
    "item_type",
    "quantity",
    "net_amount",
    "gross_amount",
    "tax_code",
    "channel",
  ] as const;
  const csv = toCsv(
    cols,
    parsed.lines.map((l) => cols.map((c) => (l[c] === undefined ? "" : String(l[c])))),
  ).replace(/^﻿/, "");
  try {
    const r = await importSales(ctx, {
      warehouseId: (connector.config as { warehouseId: string }).warehouseId,
      fileName: `webhook ${idem}`,
      text: csv,
    });
    if (!r.ok) {
      await log("REJECTED", { error: "salesRejected", errors: r.errors.slice(0, 50) });
      return { status: 422, body: { error: "salesRejected", errors: r.errors.slice(0, 50) } };
    }
    const outcome = { importId: r.importId, imported: r.imported, skipped: r.skipped };
    try {
      await log("ACCEPTED", outcome);
    } catch {
      // A concurrent request with the same key was accepted first; the import itself skipped the duplicates.
      return { status: 200, body: { duplicate: true, ...outcome } };
    }
    return { status: 200, body: outcome };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "INTERNAL";
    await log("REJECTED", { error: code });
    return { status: code === "FORBIDDEN" ? 403 : 422, body: { error: code } };
  }
}
