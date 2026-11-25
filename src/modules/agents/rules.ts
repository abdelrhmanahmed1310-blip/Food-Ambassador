import { z } from "zod";
import { Decimal } from "@/lib/decimal";

/**
 * Agent rules (DECISIONS.md ADR-140). Pure: settings per agent kind and the
 * daily close checks, so they are tested without a database.
 */

export const AGENT_KINDS = [
  "REPLENISHMENT",
  "DAILY_CLOSE",
  "INVOICE_MATCHING",
  "FOOD_SAFETY",
  "MENU_MARGIN",
] as const;
export type AgentKindCode = (typeof AGENT_KINDS)[number];
/** Phase 0 stops at drafts: nothing an agent prepares takes effect without a person. */
export const AGENT_AUTONOMY = ["SUGGEST", "DRAFT", "ACT"] as const;
export type AutonomyCode = (typeof AGENT_AUTONOMY)[number];
/**
 * How far each agent may go. Only replenishment has drafts to prepare (draft
 * purchase orders); the others propose, and the approver's action does the
 * work. "Act within limits" (ADR-145) is offered where the action is small and
 * bounded: submitting draft orders up to set amounts, raising
 * non-conformances, and price rises up to a set percent. Invoice matching
 * stays a proposal: accepting supplier differences is a finance decision.
 */
export const AUTONOMY_FOR: Record<AgentKindCode, ReadonlyArray<AutonomyCode>> = {
  REPLENISHMENT: ["SUGGEST", "DRAFT", "ACT"],
  DAILY_CLOSE: ["SUGGEST"],
  INVOICE_MATCHING: ["SUGGEST"],
  FOOD_SAFETY: ["SUGGEST", "ACT"],
  MENU_MARGIN: ["SUGGEST", "ACT"],
};

export type Severity = "INFO" | "WARNING" | "CRITICAL";
export interface Finding {
  severity: Severity;
  /** Translation key under agents.findings. */
  code: string;
  params: Record<string, string | number>;
  /** A page under the organization to look at, without the /o/{org} prefix. */
  link?: string;
  branchId?: string;
}

const uuid = z.string().uuid();
/** An amount limit in the organization's currency; 0 means nothing is done alone. */
const limitAmount = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,2})?$/)
  .default("0");
/** Hours a scheduled action waits for a person to stop it (0: at once). */
const holdHours = z.coerce.number().int().min(0).max(72);
const perRun = z.coerce.number().int().min(0).max(50);
/** After each run, Claude investigates its critical findings (ADR-149). */
const investigateCritical = z
  .preprocess((v) => v === true || v === "on" || v === "true", z.boolean())
  .default(false);

export const replenishmentSettings = z.object({
  investigateCritical,
  /** Empty: every warehouse with reorder rules the agent may order for. */
  warehouseIds: z.array(uuid).max(200).default([]),
  basis: z.enum(["MIN_MAX", "FORECAST"]).default("MIN_MAX"),
  /** Act within limits (ADR-145): submit a draft order up to this total… */
  maxOrderAmount: limitAmount,
  /** …and at most this much a day in all. */
  maxDailyAmount: limitAmount,
  holdHours: holdHours.default(4),
});
export type ReplenishmentSettings = z.infer<typeof replenishmentSettings>;

const percent = z.coerce.number().min(0).max(100);
export const dailyCloseSettings = z.object({
  investigateCritical,
  /** Empty: every branch the agent may see. */
  branchIds: z.array(uuid).max(200).default([]),
  /** A cash difference above this (absolute, in the branch currency) is reported. */
  cashTolerance: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,2})?$/)
    .default("0"),
  /** Voids above this share of the day's sales are a warning. */
  voidAlertPercent: percent.default(5),
  /** A drop against the same weekday last week above this share is a warning. */
  salesDropPercent: percent.default(30),
});
export type DailyCloseSettings = z.infer<typeof dailyCloseSettings>;

const money = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,2})?$/)
  .default("0");

export const invoiceMatchingSettings = z.object({
  investigateCritical,
  /** A credit request is proposed only above this amount (invoice currency, before VAT). */
  minCreditAmount: money,
  /** Received goods not invoiced after this many days are reported. */
  uninvoicedAfterDays: z.coerce.number().int().min(1).max(365).default(14),
});
export type InvoiceMatchingSettings = z.infer<typeof invoiceMatchingSettings>;

export const foodSafetySettings = z.object({
  investigateCritical,
  /** Empty: every branch the agent may see. */
  branchIds: z.array(uuid).max(200).default([]),
  /** A 30-day compliance score below this is reported. */
  complianceBelowPercent: percent.default(80),
  /** Stock expiring within this many days is reported. */
  expiringWithinDays: z.coerce.number().int().min(0).max(30).default(2),
  /** Act within limits (ADR-145): raise at most this many non-conformances a run. */
  maxActionsPerRun: perRun.default(3),
  holdHours: holdHours.default(4),
});
export type FoodSafetySettings = z.infer<typeof foodSafetySettings>;

export const menuMarginSettings = z.object({
  investigateCritical,
  /** An approved price starts this many days after approval. */
  effectiveInDays: z.coerce.number().int().min(0).max(30).default(1),
  /** Act within limits (ADR-145): a price rise up to this percent… */
  maxIncreasePercent: percent.default(5),
  /** …for at most this many dishes a run. */
  maxActionsPerRun: perRun.default(3),
  holdHours: holdHours.default(24),
});
export type MenuMarginSettings = z.infer<typeof menuMarginSettings>;

const SETTINGS = {
  REPLENISHMENT: replenishmentSettings,
  DAILY_CLOSE: dailyCloseSettings,
  INVOICE_MATCHING: invoiceMatchingSettings,
  FOOD_SAFETY: foodSafetySettings,
  MENU_MARGIN: menuMarginSettings,
} as const;
type SettingsOf = {
  REPLENISHMENT: ReplenishmentSettings;
  DAILY_CLOSE: DailyCloseSettings;
  INVOICE_MATCHING: InvoiceMatchingSettings;
  FOOD_SAFETY: FoodSafetySettings;
  MENU_MARGIN: MenuMarginSettings;
};

export const settingsSchema = (kind: AgentKindCode) => SETTINGS[kind];

/** Read stored settings, falling back to defaults for anything missing or invalid. */
export function readSettings<K extends AgentKindCode>(kind: K, raw: unknown): SettingsOf[K] {
  const schema = settingsSchema(kind) as unknown as z.ZodType<SettingsOf[K]>;
  const parsed = schema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : schema.parse({});
}

// ─── Daily close ───

export interface BranchDay {
  branchId: string;
  code: string;
  registers: number;
  orders: number;
  sales: Decimal;
  voids: number;
  voidAmount: Decimal;
  refunds: number;
  refundAmount: Decimal;
  /** The same weekday a week earlier; null when the branch had no sales then. */
  salesWeekAgo: Decimal | null;
  /** Shifts opened on or before the day checked and still open. */
  shiftsLeftOpen: Array<{ register: string; openedOn: string }>;
  /** Closed that day with a counted-minus-expected cash difference. */
  cashDifferences: Array<{ register: string; shift: string; difference: Decimal }>;
  /** POS stock shortfalls not posted yet. */
  shortfalls: number;
}

const pct = (part: Decimal, whole: Decimal) =>
  whole.isZero() ? new Decimal(0) : part.dividedBy(whole).times(100);

/**
 * What a manager should look at after the day, per branch, worst first.
 * Nothing is guessed: a missing comparison (no sales a week ago) is not reported.
 */
export function dailyCloseFindings(days: readonly BranchDay[], s: DailyCloseSettings): Finding[] {
  const tolerance = new Decimal(s.cashTolerance);
  const out: Finding[] = [];
  for (const d of days) {
    const base = { branchId: d.branchId };
    for (const sh of d.shiftsLeftOpen)
      out.push({
        ...base,
        severity: "CRITICAL",
        code: "SHIFT_LEFT_OPEN",
        params: { branch: d.code, register: sh.register, date: sh.openedOn },
        link: "pos",
      });
    for (const c of d.cashDifferences)
      if (c.difference.abs().gt(tolerance))
        out.push({
          ...base,
          severity: "WARNING",
          code: c.difference.isNegative() ? "CASH_SHORT" : "CASH_OVER",
          params: {
            branch: d.code,
            register: c.register,
            shift: c.shift,
            amount: c.difference.abs().toFixed(2),
          },
          link: "pos",
        });
    if (d.registers > 0 && d.orders === 0)
      out.push({ ...base, severity: "WARNING", code: "NO_SALES", params: { branch: d.code } });
    if (d.voids > 0) {
      const share = pct(d.voidAmount, d.sales.plus(d.voidAmount));
      out.push({
        ...base,
        severity: share.gt(s.voidAlertPercent) ? "WARNING" : "INFO",
        code: "VOIDS",
        params: {
          branch: d.code,
          count: d.voids,
          amount: d.voidAmount.toFixed(2),
          percent: share.toFixed(1),
        },
        link: "pos",
      });
    }
    if (d.refunds > 0)
      out.push({
        ...base,
        severity: "INFO",
        code: "REFUNDS",
        params: { branch: d.code, count: d.refunds, amount: d.refundAmount.toFixed(2) },
        link: "pos",
      });
    if (d.salesWeekAgo && d.salesWeekAgo.gt(0) && d.orders > 0) {
      const change = d.sales.minus(d.salesWeekAgo).dividedBy(d.salesWeekAgo).times(100);
      if (change.lt(-s.salesDropPercent))
        out.push({
          ...base,
          severity: "WARNING",
          code: "SALES_DROP",
          params: { branch: d.code, percent: change.abs().toFixed(1) },
          link: "reports/sales",
        });
    }
    if (d.shortfalls > 0)
      out.push({
        ...base,
        severity: "WARNING",
        code: "SHORTFALLS",
        params: { branch: d.code, count: d.shortfalls },
        link: "pos/shortfalls",
      });
  }
  const rank: Record<Severity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ─── Invoice matching ───

export interface ExceptionLine {
  lineNo: number;
  sku: string | null;
  match: string;
  quantity: Decimal;
  quantityBase: Decimal | null;
  unitPrice: Decimal;
  orderedUnitPrice: Decimal | null;
  /** Invoiced beyond what was received and not yet invoiced, in the base unit. */
  quantityVariance: Decimal | null;
  /** (Invoice − order unit price) × quantity. */
  priceVariance: Decimal | null;
}

/**
 * What the supplier billed beyond the order and the receipt, before VAT:
 * price above the order price, plus quantity beyond what was received at the
 * invoiced price. Lines billed below the order price are not netted off —
 * they are the supplier's to correct, not a reason to ask for less credit.
 */
export function creditRequest(lines: readonly ExceptionLine[]) {
  const out: Array<{
    lineNo: number;
    sku: string | null;
    reason: "PRICE" | "QUANTITY";
    amount: Decimal;
  }> = [];
  for (const l of lines) {
    if (l.priceVariance && l.priceVariance.gt(0))
      out.push({ lineNo: l.lineNo, sku: l.sku, reason: "PRICE", amount: l.priceVariance });
    if (l.quantityVariance && l.quantityVariance.gt(0) && l.quantityBase && l.quantityBase.gt(0)) {
      // Back into the invoice line's own unit, at the invoiced price.
      const inUnit = l.quantityVariance.times(l.quantity).dividedBy(l.quantityBase);
      out.push({
        lineNo: l.lineNo,
        sku: l.sku,
        reason: "QUANTITY",
        amount: inUnit.times(l.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      });
    }
  }
  const total = out.reduce((a, l) => a.plus(l.amount), new Decimal(0));
  return { lines: out, total: total.toDecimalPlaces(2, Decimal.ROUND_HALF_UP) };
}

// ─── Menu & margin ───

/**
 * The price that brings a dish back to its food cost target, as it is
 * entered: when prices include VAT, the target net price is grossed up by
 * the dish's own entered-to-net ratio. Rounded up to 0.01, so the food cost
 * is never above the target.
 */
export function targetPrice(input: {
  suggestedNet: Decimal;
  entered: Decimal;
  net: Decimal;
  includesTax: boolean;
}): Decimal {
  if (!input.includesTax || input.net.isZero()) return input.suggestedNet;
  return input.suggestedNet
    .times(input.entered)
    .dividedBy(input.net)
    .toDecimalPlaces(2, Decimal.ROUND_UP);
}

// ─── Acting within limits (ADR-145) ───

export interface ActionCandidate {
  index: number;
  kind: string;
  detail: Record<string, unknown>;
}

/**
 * Which new proposals an agent may carry out itself. Everything else stays
 * a proposal for a person. Nothing is guessed: an amount in another currency
 * than the organization's, or a missing figure, is never within a limit.
 */
export function actionsWithinLimits(
  kind: AgentKindCode,
  settings: Record<string, unknown>,
  candidates: readonly ActionCandidate[],
  context: { baseCurrency: string; actedToday: Decimal },
): number[] {
  const picked: number[] = [];
  if (kind === "REPLENISHMENT") {
    const s = settings as ReplenishmentSettings;
    const perOrder = new Decimal(s.maxOrderAmount);
    let left = new Decimal(s.maxDailyAmount).minus(context.actedToday);
    for (const c of candidates) {
      if (c.kind !== "PURCHASE_ORDER" || c.detail.currency !== context.baseCurrency) continue;
      if (typeof c.detail.total !== "string" || !/^\d+(\.\d+)?$/.test(c.detail.total)) continue;
      const total = new Decimal(c.detail.total);
      if (total.isZero() || total.gt(perOrder) || total.gt(left)) continue;
      left = left.minus(total);
      picked.push(c.index);
    }
    return picked;
  }
  if (kind === "FOOD_SAFETY") {
    const s = settings as FoodSafetySettings;
    return candidates
      .filter((c) => c.kind === "RAISE_NC")
      .slice(0, s.maxActionsPerRun)
      .map((c) => c.index);
  }
  if (kind === "MENU_MARGIN") {
    const s = settings as MenuMarginSettings;
    for (const c of candidates) {
      if (picked.length >= s.maxActionsPerRun) break;
      if (c.kind !== "PRICE_CHANGE") continue;
      const price = Number(c.detail.price);
      const next = Number(c.detail.newPrice);
      if (!(price > 0) || !(next > price)) continue;
      const rise = new Decimal(String(c.detail.newPrice))
        .dividedBy(String(c.detail.price))
        .minus(1)
        .times(100);
      if (rise.lte(s.maxIncreasePercent)) picked.push(c.index);
    }
    return picked;
  }
  return picked;
}
