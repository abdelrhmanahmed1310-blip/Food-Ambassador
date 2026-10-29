import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/server/db/client";
import { getAuth } from "./auth";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  locale: string;
}

/**
 * The signed-in user for this request, or null. Sessions are validated
 * server-side against the database (expired or revoked sessions are rejected
 * by the auth library), and disabled users are treated as signed out.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const user = await getDb().user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, locale: true, status: true },
  });
  if (!user || user.status !== "ACTIVE") return null;
  return { id: user.id, name: user.name, email: user.email, locale: user.locale };
});

export async function requireUser(nextPath?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(nextPath ? `/sign-in?next=${encodeURIComponent(nextPath)}` : "/sign-in");
  return user;
}

/** Only same-site relative paths are accepted as post-sign-in destinations (no open redirects). */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}
