"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { LOCALE_COOKIE, isLocale } from "@/i18n/config";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";

const ONE_YEAR = 60 * 60 * 24 * 365;

/** Persist the chosen language in a cookie and, when signed in, on the user profile (AC1.7). */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = formData.get("locale");
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: ONE_YEAR,
    sameSite: "lax",
    httpOnly: true,
  });
  const user = await getCurrentUser();
  if (user) await getDb().user.update({ where: { id: user.id }, data: { locale } });
  revalidatePath("/", "layout");
}
