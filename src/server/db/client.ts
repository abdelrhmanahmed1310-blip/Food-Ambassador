import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/server/env";

// One client (and connection pool) per process. In development, Next.js hot
// reload re-evaluates modules, so the instance is kept on globalThis.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

/**
 * Raw database client. Business modules must not import this directly once
 * tenant-scoped data access exists (Milestone 1); they go through the
 * tenant-aware repositories so isolation is enforced in one place.
 */
export function getDb(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}
