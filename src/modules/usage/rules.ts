import { z } from "zod";

/**
 * Usage metering rules (DECISIONS.md ADR-146). Pure: what is counted, the
 * limits an organization may set, and the calendar windows they apply to.
 * Nothing here is priced: the app counts; plans and prices are agreed outside it.
 */

export const USAGE_METRICS = [
  "agent.runs",
  "agent.actions",
  "agent.approvals",
  "ai.input_tokens",
  "ai.output_tokens",
  "mcp.calls",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/** Empty or missing: no limit. */
const cap = z
  // null first: a stored "no limit" must never be coerced to 0.
  .union([z.null(), z.literal(""), z.coerce.number().int().min(0).max(1_000_000_000)])
  .optional()
  .transform((v) => (v === "" || v === undefined || v === null ? null : v));

export const usageLimitsSchema = z.object({
  /** Actions agents carry out themselves in a calendar month (ADR-145). */
  agentActionsPerMonth: cap,
  /** Claude input and output tokens together in a calendar month (assistant and explanations). */
  aiTokensPerMonth: cap,
  /** MCP tool calls in a day (ADR-143). */
  mcpCallsPerDay: cap,
});
export type UsageLimits = z.infer<typeof usageLimitsSchema>;

export function readLimits(raw: unknown): UsageLimits {
  const parsed = usageLimitsSchema.safeParse(raw ?? {});
  return parsed.success
    ? parsed.data
    : { agentActionsPerMonth: null, aiTokensPerMonth: null, mcpCallsPerDay: null };
}

export type LimitKey = keyof UsageLimits;
export const LIMIT_METRICS: Record<LimitKey, readonly UsageMetric[]> = {
  agentActionsPerMonth: ["agent.actions"],
  aiTokensPerMonth: ["ai.input_tokens", "ai.output_tokens"],
  mcpCallsPerDay: ["mcp.calls"],
};

/** First and last day of the month of `day` (YYYY-MM-DD). */
export function monthOf(day: string): { from: string; to: string; month: string } {
  const [y, m] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const month = `${y}-${String(m).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}`, month };
}

/** The window a limit counts over, for `today` in the organization's calendar. */
export function limitWindow(key: LimitKey, today: string) {
  if (key === "mcpCallsPerDay") return { from: today, to: today };
  const m = monthOf(today);
  return { from: m.from, to: m.to };
}

export const isMonth = (v: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** What is left under a limit; null when there is none. */
export function remaining(limit: number | null, used: number): number | null {
  return limit === null ? null : Math.max(limit - used, 0);
}
