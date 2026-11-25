import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { USAGE_METRICS, type UsageMetric } from "@/modules/usage/rules";

/**
 * Plans and statements (DECISIONS.md ADR-147). Pure. Every price comes from
 * the platform operator; nothing here has a default price but zero.
 */

const amount = (maxScale: number) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{1,12}(\\.\\d{1,${maxScale}})?$`), { error: "invalidDecimal" });

export const metricPricing = z.object({
  /** Included in the monthly fee. */
  included: z.coerce.number().int().min(0).max(1_000_000_000_000).default(0),
  /** Price for each `per` units beyond what is included. */
  unitPrice: amount(8).default("0"),
  /** 1, 1 000 or 1 000 000 units (tokens are priced per thousand or million). */
  per: z.coerce
    .number()
    .refine((v) => [1, 1000, 1_000_000].includes(v), { error: "invalidOption" })
    .default(1),
});
export type MetricPricing = z.infer<typeof metricPricing>;

export const planSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/, { error: "invalidCode" }),
  name: z.string().trim().min(1, { error: "required" }).max(100),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { error: "invalidCurrency" }),
  monthlyFee: amount(4),
  pricing: z.partialRecord(z.enum(USAGE_METRICS), metricPricing).default({}),
});
export type PlanInput = z.infer<typeof planSchema>;

export interface StatementLine {
  kind: "FEE" | "USAGE";
  metric: UsageMetric | null;
  used: number;
  included: number;
  billable: number;
  unitPrice: string;
  per: number;
  amount: string;
}

/**
 * A month's statement: the fee, then each priced metric — what was used, what
 * the plan includes, what is beyond it, and its price — rounded to the cent
 * per line. Metrics the plan does not price are listed at no charge.
 */
export function computeStatement(
  plan: { monthlyFee: string; pricing: Partial<Record<UsageMetric, MetricPricing>> },
  used: Partial<Record<UsageMetric, number>>,
): { lines: StatementLine[]; total: string } {
  const lines: StatementLine[] = [
    {
      kind: "FEE",
      metric: null,
      used: 0,
      included: 0,
      billable: 0,
      unitPrice: new Decimal(plan.monthlyFee).toFixed(2),
      per: 1,
      amount: new Decimal(plan.monthlyFee).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    },
  ];
  for (const metric of USAGE_METRICS) {
    const p = plan.pricing[metric] ?? { included: 0, unitPrice: "0", per: 1 };
    const u = used[metric] ?? 0;
    if (u === 0 && !plan.pricing[metric]) continue;
    // An item the plan does not price is shown as used, with nothing charged.
    const billable = plan.pricing[metric] ? Math.max(u - p.included, 0) : 0;
    const charge = new Decimal(billable)
      .dividedBy(p.per)
      .times(p.unitPrice)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    lines.push({
      kind: "USAGE",
      metric,
      used: u,
      included: p.included,
      billable,
      unitPrice: p.unitPrice,
      per: p.per,
      amount: charge.toFixed(2),
    });
  }
  const total = lines.reduce((a, l) => a.plus(l.amount), new Decimal(0));
  return { lines, total: total.toFixed(2) };
}

/** The operator list: comma-separated emails, case and spaces ignored. */
export function isListedEmail(list: string | undefined, email: string): boolean {
  return (list ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}

/** Thresholds a limit warning is sent at (ADR-147). */
export const WARN_AT = [80, 100] as const;
export function crossedThreshold(used: number, limit: number | null): 80 | 100 | null {
  if (limit === null) return null;
  if (limit === 0 || used >= limit) return 100;
  return used * 100 >= limit * 80 ? 80 : null;
}
