import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { isUuid } from "@/lib/uuid";
import { getDb } from "./client";

export type Tx = Prisma.TransactionClient;

const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/**
 * Run `fn` in a transaction restricted to one organization by PostgreSQL
 * row-level security (ADR-006): `app.organization_id` is set for the
 * transaction and the role is switched to `fa_tenant`, whose policies hide
 * and reject every row of other organizations. Application code still filters
 * by organizationId explicitly; RLS is the safety net if a filter is missed.
 */
export async function withTenantTx<T>(
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isUuid(organizationId)) throw new Error("withTenantTx requires a valid organization id");
  return getDb().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    await tx.$executeRawUnsafe("SET LOCAL ROLE fa_tenant");
    return fn(tx);
  }, TX_OPTIONS);
}

/**
 * Transaction with the connection's own (owner) privileges, bypassing RLS.
 * Only for operations that are inherently cross-tenant or happen before a
 * tenant context exists: sign-up/organization creation, invitation lookup and
 * acceptance, resolving a user's memberships. Every query inside must filter
 * by an identifier derived from the authenticated user.
 */
export async function withSystemTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().$transaction(fn, TX_OPTIONS);
}
