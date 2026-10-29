import { z } from "zod";
import { isUuid } from "@/lib/uuid";

/**
 * Shared Zod building blocks. Error messages are translation keys
 * (`validation.<key>` in src/i18n/messages), resolved by the UI layer.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const LOCALES = ["en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

const SUPPORTED_TIME_ZONES = new Set(Intl.supportedValuesOf("timeZone").concat("UTC"));
const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export const requiredText = (max: number) =>
  z
    .string({ error: "required" })
    .trim()
    .min(1, { error: "required" })
    .max(max, { error: "tooLong" });

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: "tooLong" })
    .optional()
    .transform((v) => (v ? v : undefined));

export const emailSchema = z
  .string({ error: "required" })
  .trim()
  .toLowerCase()
  .min(1, { error: "required" })
  .max(254, { error: "tooLong" })
  .pipe(z.email({ error: "invalidEmail" }));

export const uuidSchema = z
  .string({ error: "required" })
  .refine(isUuid, { error: "invalidReference" });
export const optionalUuidSchema = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || isUuid(v), { error: "invalidReference" });

export const timeZoneSchema = z
  .string({ error: "required" })
  .refine((tz) => SUPPORTED_TIME_ZONES.has(tz), { error: "invalidTimeZone" });
export const optionalTimeZoneSchema = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || SUPPORTED_TIME_ZONES.has(v), { error: "invalidTimeZone" });

export const currencySchema = z
  .string({ error: "required" })
  .trim()
  .toUpperCase()
  .refine((c) => /^[A-Z]{3}$/.test(c) && SUPPORTED_CURRENCIES.has(c), { error: "invalidCurrency" });

export const localeSchema = z.enum(LOCALES, { error: "invalidOption" });

/** Business codes: upper-case letters, digits, '-' and '_' (e.g. "CAI-01"). */
export const codeSchema = z
  .string({ error: "required" })
  .trim()
  .toUpperCase()
  .min(1, { error: "required" })
  .max(20, { error: "tooLong" })
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/, { error: "invalidCode" });

export const idempotencyKeySchema = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || (v.length >= 8 && v.length <= 100), { error: "invalidFormat" });

export const pageSchema = z.coerce.number().int().min(1).catch(1);
