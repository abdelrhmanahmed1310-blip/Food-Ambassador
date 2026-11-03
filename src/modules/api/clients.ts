import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertPermission, type Grant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { requiredText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { consumeRateLimit } from "@/server/rate-limit";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { API_SCOPE_NAMES, parseApiKey, permissionsOf } from "./scopes";

/**
 * API keys for the REST API v1 (DECISIONS.md ADR-090). Created and revoked
 * by people who manage integrations; the key is shown once and only its
 * SHA-256 is stored. A request with a key acts with the key's read scopes,
 * limited to its company when one is set, and with row-level security like
 * any other request. Each key has its own rate limit.
 */

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const alnum = (bytes: number) =>
  randomBytes(bytes)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 12);

const clientSchema = z.object({
  name: requiredText(80),
  scopes: z
    .array(z.enum(API_SCOPE_NAMES, { error: "invalidOption" }))
    .min(1, { error: "required" }),
  companyId: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.uuid({ error: "invalidOption" }).optional()),
});

export async function createApiClient(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "integrations.manage");
  const parsed = clientSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  let prefix = alnum(16);
  while (prefix.length < 12) prefix += alnum(16);
  prefix = prefix.slice(0, 12);
  const secret = randomBytes(32).toString("base64url");
  return withTenantTx(ctx.organizationId, async (tx) => {
    if (
      input.companyId &&
      !(await tx.company.findFirst({
        where: { organizationId: ctx.organizationId, id: input.companyId, archivedAt: null },
        select: { id: true },
      }))
    )
      throw businessRuleViolation("BRANCH_COMPANY_INVALID", "Choose an active company", {
        field: "companyId",
      });
    const client = await tx.apiClient.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name,
        keyPrefix: prefix,
        keyHash: hash(secret),
        scopes: input.scopes,
        companyId: input.companyId ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, name: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "api_client.created",
      entityType: "api_client",
      entityId: client.id,
      changes: { name: input.name, scopes: input.scopes, companyId: input.companyId ?? null },
    });
    // The only time the full key exists outside the caller's hands.
    return { ...client, key: `fa_${prefix}_${secret}` };
  });
}

export async function listApiClients(ctx: TenantContext) {
  assertPermission(ctx.grants, "integrations.manage");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.apiClient.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
        company: { select: { code: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );
}

export async function revokeApiClient(ctx: TenantContext, id: string) {
  assertPermission(ctx.grants, "integrations.manage");
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw notFound("API key");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.apiClient.findFirst({
      where: { organizationId: ctx.organizationId, id: parsed.data },
    });
    if (!c) throw notFound("API key");
    if (c.revokedAt) return;
    await tx.apiClient.update({
      where: { id: c.id },
      data: { revokedAt: new Date(), revokedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "api_client.revoked",
      entityType: "api_client",
      entityId: c.id,
      changes: { name: c.name },
    });
  });
}

export interface ApiContext {
  ctx: TenantContext;
  clientId: string;
  scopes: string[];
  /** Only this company's documents and sites, when set. */
  companyId: string | null;
}

export type ApiAuthResult =
  | { ok: true; api: ApiContext }
  | { ok: false; status: 401 | 429; code: "UNAUTHORIZED" | "RATE_LIMITED"; retryAfter?: number };

/** Requests per key per minute. */
export const API_RATE_LIMIT = 600;

/** Who is calling: the key in `Authorization: Bearer fa_…`, checked in constant time. */
export async function authenticateApiRequest(authorization: string | null): Promise<ApiAuthResult> {
  const key = parseApiKey(authorization);
  if (!key) return { ok: false, status: 401, code: "UNAUTHORIZED" };
  const client = await withSystemTx((tx) =>
    tx.apiClient.findUnique({
      where: { keyPrefix: key.prefix },
      include: {
        organization: {
          select: {
            id: true,
            slug: true,
            name: true,
            baseCurrency: true,
            timeZone: true,
            status: true,
          },
        },
      },
    }),
  );
  const given = Buffer.from(hash(key.secret), "hex");
  const stored = Buffer.from(client?.keyHash ?? "0".repeat(64), "hex");
  if (
    !client ||
    !timingSafeEqual(given, stored) ||
    client.revokedAt ||
    client.organization.status !== "ACTIVE"
  )
    return { ok: false, status: 401, code: "UNAUTHORIZED" };
  const limit = await consumeRateLimit(`api:${client.id}`, { window: 60, max: API_RATE_LIMIT });
  if (!limit.allowed)
    return { ok: false, status: 429, code: "RATE_LIMITED", retryAfter: limit.retryAfter ?? 60 };
  // Last use, at most once a minute.
  if (!client.lastUsedAt || Date.now() - client.lastUsedAt.getTime() > 60_000)
    await withSystemTx((tx) =>
      tx.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date() } }),
    );
  const org = client.organization;
  const grants: Grant[] = permissionsOf(client.scopes).map((permission) => ({
    permission,
    scope: { type: "ORGANIZATION" },
    roleKey: "api",
  }));
  return {
    ok: true,
    api: {
      clientId: client.id,
      scopes: client.scopes,
      companyId: client.companyId,
      ctx: {
        organizationId: org.id,
        organizationSlug: org.slug,
        organizationName: org.name,
        baseCurrency: org.baseCurrency,
        groupCurrency: org.baseCurrency,
        timeZone: org.timeZone,
        // Reads only; the person who created the key, for traceability.
        userId: client.createdByUserId,
        membershipId: "",
        grants,
      },
    },
  };
}
