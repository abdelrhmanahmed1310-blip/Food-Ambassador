import "server-only";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { attentionItems } from "@/modules/analytics/attention";
import { salesAnalytics } from "@/modules/analytics/sales";
import { branchPnl } from "@/modules/finance/pnl";
import { warehouseForecast } from "@/modules/forecasting/demand";
import { listBalances, warehouseOptions } from "@/modules/inventory/queries";
import { reorderPlan } from "@/modules/procurement/reorder";
import { listBranchOptions } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { toPlain, type Source } from "./rules";

/**
 * What the assistant can read (DECISIONS.md ADR-122). Every tool calls the
 * same service the app's own page uses, with the asking person's context, so
 * it sees exactly what they may see. Each tool picks business fields
 * explicitly: no guest, staff or contact details are ever returned.
 */

export interface ToolOutput {
  data: unknown;
  sources: Source[];
}

interface AssistantTool<S extends z.ZodType> {
  definition: BetaTool;
  input: S;
  run(ctx: TenantContext, input: z.infer<S>): Promise<ToolOutput>;
}

const date = z.string().refine(isCalendarDate, { error: "invalidDate" });
const id = z.uuid();
const period = { from: date, to: date };
const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  return q ? `?${q}` : "";
};

/** A strict JSON schema: every property listed, nothing else accepted. */
export function schema(
  properties: Record<string, { type: string; description: string; enum?: string[] }>,
  required: string[] = [],
): BetaTool["input_schema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

export const tool = <S extends z.ZodType>(t: AssistantTool<S>) => t;

const DATE_HINT = "Calendar date, YYYY-MM-DD.";

export const TOOLS = [
  tool({
    definition: {
      name: "list_sites",
      description:
        "Branches and warehouses this person can see, with their IDs, codes and names. Call it first when a question names a site.",
      input_schema: schema({}),
      strict: true,
    },
    input: z.object({}).strict(),
    async run(ctx) {
      const [branches, warehouses] = await Promise.all([
        listBranchOptions(ctx),
        warehouseOptions(ctx, "inventory.view"),
      ]);
      return {
        data: {
          branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name })),
          warehouses: warehouses.map((w) => ({ id: w.id, code: w.code, name: w.name })),
        },
        sources: [{ label: "Branches", href: "/branches" }],
      };
    },
  }),
  tool({
    definition: {
      name: "sales_summary",
      description:
        "Net sales, orders and average ticket for a period, with growth against the previous period and last year, targets, and the split by branch, channel and weekday. Daily figures for periods up to 31 days.",
      input_schema: schema(
        {
          from: { type: "string", description: DATE_HINT },
          to: { type: "string", description: DATE_HINT },
          branchId: { type: "string", description: "Optional branch ID from list_sites." },
        },
        ["from", "to"],
      ),
      strict: true,
    },
    input: z.object({ ...period, branchId: id.optional() }).strict(),
    async run(ctx, i) {
      const s = await salesAnalytics(ctx, { from: i.from, to: i.to }, { branchId: i.branchId });
      return {
        data: {
          period: s.period,
          currency: s.currency,
          missingExchangeRates: s.missingRates,
          total: {
            net: s.total.net,
            orders: s.total.orders,
            averageTicket: s.total.averageTicket,
            growthPrevious: s.total.growthPrevious,
            growthLastYear: s.total.growthLastYear,
            target: s.total.target,
            achievement: s.total.achievement,
          },
          branches: s.branches.map((b) => ({
            code: b.branch.code,
            name: b.branch.name,
            net: b.net,
            orders: b.orders,
            averageTicket: b.averageTicket,
            share: b.share,
            growthPrevious: b.growthPrevious,
            target: b.target,
            achievement: b.achievement,
          })),
          channels: s.channels.map((c) => ({
            channel: c.channel,
            net: c.net,
            orders: c.orders,
            share: c.share,
          })),
          weekdays: s.weekdays.map((w) => ({
            isoWeekday: w.weekday,
            net: w.net,
            orders: w.orders,
          })),
          days:
            s.days.length <= 31
              ? s.days.map((d) => ({ day: d.day, net: d.net, orders: d.orders }))
              : undefined,
        },
        sources: [
          {
            label: `Sales ${i.from} – ${i.to}`,
            href: `/reports/sales${query({ from: i.from, to: i.to, branch: i.branchId })}`,
          },
        ],
      };
    },
  }),
  tool({
    definition: {
      name: "stock_levels",
      description:
        "Stock on hand by warehouse, product and lot: usable quantity, status and expiry. Up to 50 rows, soonest expiry first.",
      input_schema: schema({
        warehouseId: { type: "string", description: "Optional warehouse ID from list_sites." },
        search: { type: "string", description: "Optional SKU or product name to match." },
        expiry: {
          type: "string",
          enum: ["expired", "expiring"],
          description: "Optional: only expired stock, or stock expiring soon.",
        },
      }),
      strict: true,
    },
    input: z
      .object({
        warehouseId: id.optional(),
        search: z.string().max(100).optional(),
        expiry: z.enum(["expired", "expiring"]).optional(),
      })
      .strict(),
    async run(ctx, i) {
      const r = await listBalances(ctx, {
        warehouseId: i.warehouseId,
        q: i.search,
        expiry: i.expiry,
      });
      return {
        data: {
          today: r.today,
          rowsMatching: r.total,
          rows: r.items.slice(0, 50).map((b) => ({
            warehouse: b.warehouse.code,
            sku: b.product.sku,
            product: b.product.nameEn,
            unit: b.product.baseUom,
            lot: b.lot?.lotCode ?? null,
            expiresOn: b.lot?.expiresOn ?? null,
            recallHold: b.lot?.recallHold ?? false,
            status: b.stockStatus,
            onHand: b.onHand,
            usable: b.available,
            expiry: b.expiry,
          })),
        },
        sources: [
          {
            label: "Stock on hand",
            href: `/inventory/stock${query({ warehouseId: i.warehouseId, q: i.search, expiry: i.expiry })}`,
          },
        ],
      };
    },
  }),
  tool({
    definition: {
      name: "needs_attention",
      description:
        "What needs attention now: expiring or expired stock, items below reorder level, approvals waiting, overdue invoices, food safety and other open tasks, with counts.",
      input_schema: schema({}),
      strict: true,
    },
    input: z.object({}).strict(),
    async run(ctx) {
      const items = await attentionItems(ctx);
      return {
        // Counts and amounts only: the linked records can name people.
        data: items.map((a) => ({ key: a.key, tone: a.tone, count: a.count, amount: a.amount })),
        sources: [{ label: "Needs attention", href: "/" }],
      };
    },
  }),
  tool({
    definition: {
      name: "demand_forecast",
      description:
        "Demand forecast per product for one warehouse: last 8 weeks of demand, average a day, the method used and its error (WAPE) and bias, and forecast demand for the next 7 and 28 days.",
      input_schema: schema(
        { warehouseId: { type: "string", description: "Warehouse ID from list_sites." } },
        ["warehouseId"],
      ),
      strict: true,
    },
    input: z.object({ warehouseId: id }).strict(),
    async run(ctx, i) {
      const f = await warehouseForecast(ctx, i.warehouseId);
      return {
        data: {
          warehouse: f.warehouse.code,
          asOf: f.today,
          rows: f.rows.map((r) => ({
            sku: r.product.sku,
            product: r.product.nameEn,
            unit: r.product.baseUom.code,
            weeklyDemand: r.weeks,
            averageDaily28d: r.recentDaily,
            ...(r.result.status === "OK"
              ? {
                  method: r.result.method,
                  wape: r.result.accuracy.wape,
                  bias: r.result.accuracy.bias,
                }
              : { method: null, note: `Not enough history (${r.historyDays} of 28 days)` }),
            next7: r.next7,
            next28: r.next28,
          })),
        },
        sources: [
          {
            label: `Demand forecast ${f.warehouse.code}`,
            href: `/purchasing/forecast?warehouseId=${i.warehouseId}`,
          },
        ],
      };
    },
  }),
  tool({
    definition: {
      name: "reorder_suggestions",
      description:
        "Reorder plan for one warehouse: usable stock, open orders, min–max levels, the suggested order by level and by forecast, and the supplier.",
      input_schema: schema(
        { warehouseId: { type: "string", description: "Warehouse ID from list_sites." } },
        ["warehouseId"],
      ),
      strict: true,
    },
    input: z.object({ warehouseId: id }).strict(),
    async run(ctx, i) {
      const p = await reorderPlan(ctx, i.warehouseId);
      return {
        data: {
          warehouse: p.warehouse.code,
          rows: p.lines.map((l) => ({
            sku: l.rule.product.sku,
            product: l.rule.product.nameEn,
            unit: l.rule.product.baseUom.code,
            usable: l.availableBase,
            onOrder: l.onOrderBase,
            min: l.rule.minQuantityBase,
            max: l.rule.maxQuantityBase,
            suggestedByLevel: l.suggestion?.purchaseUnits ?? null,
            suggestedByForecast: l.forecast.order?.purchaseUnits ?? null,
            purchaseUnit: l.source?.purchaseUom.code ?? null,
            forecastNote: l.forecast.reason,
            problem: l.reason !== "OK" ? l.reason : null,
            supplier: l.source ? `${l.source.supplier.code} — ${l.source.supplier.name}` : null,
          })),
        },
        sources: [
          {
            label: `Reorder ${p.warehouse.code}`,
            href: `/purchasing/reorder?warehouseId=${i.warehouseId}`,
          },
        ],
      };
    },
  }),
  tool({
    definition: {
      name: "branch_pnl",
      description:
        "Branch profit and loss for a period: sales by source, cost of sales, gross profit, stock losses, expenses by group and operating result, each with its share of sales. One column per branch (or per month for one branch), in the company's currency.",
      input_schema: schema(
        {
          from: { type: "string", description: DATE_HINT },
          to: { type: "string", description: DATE_HINT },
          branchId: { type: "string", description: "Optional branch ID from list_sites." },
        },
        ["from", "to"],
      ),
      strict: true,
    },
    input: z.object({ ...period, branchId: id.optional() }).strict(),
    async run(ctx, i) {
      const p = await branchPnl(ctx, { from: i.from, to: i.to }, { branchId: i.branchId });
      return {
        data: {
          period: p.period,
          rows: p.rows,
          columns: p.columns.map((c) => ({
            label: c.label,
            kind: c.kind,
            currency: c.currency,
            values: c.values,
            shareOfSales: c.shares,
          })),
        },
        sources: [
          {
            label: `Branch P&L ${i.from} – ${i.to}`,
            href: `/finance/pnl${query({ from: i.from, to: i.to, branch: i.branchId })}`,
          },
        ],
      };
    },
  }),
] as const;

export const TOOL_DEFINITIONS: BetaTool[] = TOOLS.map((t) => t.definition);

export type ToolResult = { ok: true; output: ToolOutput } | { ok: false; error: string };

/** Run one tool call; the result is plain JSON for the model. */
export async function runTool(ctx: TenantContext, name: string, rawInput: unknown) {
  return runToolFrom(TOOLS, ctx, name, rawInput);
}

/** Run a call against a given tool list (the business tools or the consultant's, ADR-131). */
export async function runToolFrom(
  list: ReadonlyArray<{ definition: BetaTool; input: z.ZodType; run: unknown }>,
  ctx: TenantContext,
  name: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const t = list.find((x) => x.definition.name === name);
  if (!t) return { ok: false, error: `Unknown tool ${name}` };
  const parsed = t.input.safeParse(rawInput ?? {});
  if (!parsed.success)
    return {
      ok: false,
      error: `Invalid input: ${parsed.error.issues.map((x) => x.path.join(".") + " " + x.message).join("; ")}`,
    };
  try {
    // Each tool narrows its own input type; TOOLS is a heterogeneous tuple.
    const output = await (t.run as (c: TenantContext, i: unknown) => Promise<ToolOutput>)(
      ctx,
      parsed.data,
    );
    return { ok: true, output: { data: toPlain(output.data), sources: output.sources } };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "FORBIDDEN" || code === "NOT_FOUND")
      return { ok: false, error: "Not permitted for this person, or not found." };
    if (code === "VALIDATION_FAILED") return { ok: false, error: "Invalid input for this report." };
    throw error;
  }
}
