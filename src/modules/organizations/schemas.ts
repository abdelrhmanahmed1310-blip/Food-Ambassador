import { z } from "zod";
import {
  currencySchema,
  localeSchema,
  requiredText,
  timeZoneSchema,
} from "@/modules/shared/schemas";

export const createOrganizationSchema = z.object({
  name: requiredText(120),
  baseCurrency: currencySchema,
  timeZone: timeZoneSchema,
  defaultLocale: localeSchema.default("en"),
});
export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

/** Base currency is fixed at creation: every cost and valuation is expressed in it. */
export const updateOrganizationSchema = z.object({
  name: requiredText(120),
  timeZone: timeZoneSchema,
  defaultLocale: localeSchema,
});
export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;
