import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { conflict } from "@/server/errors";

type Json = Prisma.InputJsonValue;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function requestHash(operation: string, input: unknown): string {
  return createHash("sha256")
    .update(`${operation}\n${stableStringify(input)}`)
    .digest("hex");
}

/**
 * Run a tenant mutation at most once per (organization, user, key).
 *
 * The key row is inserted in the same transaction as the mutation, so either
 * both commit or neither does. A concurrent duplicate blocks on the unique
 * index, then fails; we then return the result the first request stored.
 * Reusing a key with a different payload is rejected.
 */
export async function runIdempotent<T extends Json>(
  ctx: TenantContext,
  request: { key: string | undefined; operation: string; input: unknown },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!request.key) return withTenantTx(ctx.organizationId, fn);
  const key = request.key;
  const hash = requestHash(request.operation, request.input);
  const where = {
    organizationId_userId_key: { organizationId: ctx.organizationId, userId: ctx.userId, key },
  };

  const replay = (
    existing: { requestHash: string; operation: string; result: unknown } | null,
  ): T | undefined => {
    if (!existing) return undefined;
    if (existing.requestHash !== hash || existing.operation !== request.operation) {
      throw conflict("Idempotency key was already used for a different request", {
        reason: "IDEMPOTENCY_KEY_REUSED",
      });
    }
    return existing.result as T;
  };

  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const previous = replay(await tx.idempotencyKey.findUnique({ where }));
      if (previous !== undefined) return previous;
      const result = await fn(tx);
      await tx.idempotencyKey.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          key,
          operation: request.operation,
          requestHash: hash,
          result,
        },
      });
      return result;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent request with the same key may have committed first.
    const existing = await withTenantTx(ctx.organizationId, (tx) =>
      tx.idempotencyKey.findUnique({ where }),
    );
    const previous = replay(existing);
    if (previous !== undefined) return previous;
    throw error;
  }
}
