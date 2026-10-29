import { LOCALES, type Locale } from "@/modules/shared/schemas";

export { LOCALES, type Locale };
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "fa_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}
