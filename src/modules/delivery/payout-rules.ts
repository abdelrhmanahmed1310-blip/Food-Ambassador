import { Decimal, roundMoney, sum } from "@/lib/decimal";
import { parseCsvRecords } from "@/lib/csv";

/**
 * Delivery platform payouts (DECISIONS.md ADR-075): the platform's settlement
 * statement, read from one canonical CSV whatever the platform — each
 * platform's own export is renamed to these columns (their statement formats
 * are partner-only and not invented here).
 *
 *   order_id      the platform's order id; empty for an adjustment
 *   description   optional (what an adjustment is)
 *   gross         what the customer paid for the order on the platform
 *   commission    the platform's commission
 *   fees          other fees (payment, marketing, delivery)
 *   vat_on_fees   VAT the platform charged on commission and fees
 *   net           paid to the restaurant = gross − commission − fees − vat_on_fees
 *
 * Several rows for one order (an order and a later refund or correction) are
 * added together.
 */

export const MAX_PAYOUT_ROWS = 5000;
export const PAYOUT_TEMPLATE =
  "order_id,description,gross,commission,fees,vat_on_fees,net\nHS-100231,,58.00,11.60,1.50,1.97,42.93\n,Marketing campaign,0,0,50.00,7.50,-57.50\n";

const TOLERANCE = new Decimal("0.01");
const AMOUNT = /^-?\d{1,12}(\.\d{1,4})?$/;

export interface PayoutRowError {
  row: number;
  column: string;
  message: string;
}

export interface PayoutLineInput {
  lineNo: number;
  externalId: string | null;
  description: string | null;
  gross: Decimal;
  commission: Decimal;
  fees: Decimal;
  vatOnFees: Decimal;
  net: Decimal;
}

/** Parse and check a statement; nothing is accepted unless every row is fine. */
export function parsePayoutCsv(
  text: string,
): { ok: true; lines: PayoutLineInput[] } | { ok: false; errors: PayoutRowError[] } {
  const { headers, records } = parseCsvRecords(text.replace(/^﻿/, ""));
  const missing = ["order_id", "gross", "net"].filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    return {
      ok: false,
      errors: missing.map((column) => ({ row: 1, column, message: "missingColumn" })),
    };
  }
  const rows = records.filter((r) => Object.values(r).some((v) => v !== ""));
  if (rows.length === 0) return { ok: false, errors: [{ row: 1, column: "", message: "noRows" }] };
  if (rows.length > MAX_PAYOUT_ROWS) {
    return { ok: false, errors: [{ row: 1, column: "", message: "tooManyRows" }] };
  }

  const errors: PayoutRowError[] = [];
  const merged = new Map<string, PayoutLineInput>();
  const lines: PayoutLineInput[] = [];
  rows.forEach((r, i) => {
    const row = i + 2;
    const amount = (column: string, required: boolean): Decimal | null => {
      const raw = (r[column] ?? "").replace(/,/g, "");
      if (raw === "") {
        if (required) errors.push({ row, column, message: "required" });
        return required ? null : new Decimal(0);
      }
      if (!AMOUNT.test(raw)) {
        errors.push({ row, column, message: "invalidDecimal" });
        return null;
      }
      return new Decimal(raw);
    };
    const externalId = (r["order_id"] ?? "").trim() || null;
    const description = (r["description"] ?? "").trim().slice(0, 200) || null;
    if (externalId && externalId.length > 100) {
      errors.push({ row, column: "order_id", message: "tooLong" });
      return;
    }
    const gross = amount("gross", externalId !== null);
    const commission = amount("commission", false);
    const fees = amount("fees", false);
    const vatOnFees = amount("vat_on_fees", false);
    const net = amount("net", true);
    if (!gross || !commission || !fees || !vatOnFees || !net) return;
    if (!externalId && !description) {
      errors.push({ row, column: "description", message: "adjustmentNeedsDescription" });
      return;
    }
    if (
      net.minus(gross.minus(commission).minus(fees).minus(vatOnFees)).abs().greaterThan(TOLERANCE)
    ) {
      errors.push({ row, column: "net", message: "netDoesNotAddUp" });
      return;
    }
    const prior = externalId ? merged.get(externalId) : undefined;
    if (prior) {
      prior.gross = prior.gross.plus(gross);
      prior.commission = prior.commission.plus(commission);
      prior.fees = prior.fees.plus(fees);
      prior.vatOnFees = prior.vatOnFees.plus(vatOnFees);
      prior.net = prior.net.plus(net);
      prior.description ??= description;
      return;
    }
    const line: PayoutLineInput = {
      lineNo: lines.length + 1,
      externalId,
      description,
      gross,
      commission,
      fees,
      vatOnFees,
      net,
    };
    lines.push(line);
    if (externalId) merged.set(externalId, line);
  });
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, lines };
}

export type PayoutMatch =
  | "MATCHED"
  | "AMOUNT_DIFFERS"
  | "NOT_FOUND"
  | "CANCELLED_ORDER"
  | "NOT_ACCEPTED"
  | "ALREADY_PAID"
  | "ADJUSTMENT";

export interface KnownOrder {
  status: "PENDING" | "NEEDS_MAPPING" | "ACCEPTED" | "REJECTED" | "CANCELLED";
  total: Decimal;
  /** Settled by a line of another confirmed payout. */
  settledElsewhere: boolean;
}

/** How a statement line compares with the order we received. */
export function matchLine(
  line: Pick<PayoutLineInput, "externalId" | "gross">,
  order: KnownOrder | undefined,
): PayoutMatch {
  if (!line.externalId) return "ADJUSTMENT";
  if (!order) return "NOT_FOUND";
  if (order.status === "CANCELLED") return "CANCELLED_ORDER";
  if (order.status !== "ACCEPTED") return "NOT_ACCEPTED";
  if (order.settledElsewhere) return "ALREADY_PAID";
  return line.gross.minus(order.total).abs().greaterThan(TOLERANCE) ? "AMOUNT_DIFFERS" : "MATCHED";
}

/** Lines that settle their order when the payout is confirmed. */
export const SETTLES: ReadonlySet<PayoutMatch> = new Set(["MATCHED", "AMOUNT_DIFFERS"]);

export function payoutTotals(
  lines: readonly Pick<PayoutLineInput, "gross" | "commission" | "fees" | "vatOnFees" | "net">[],
) {
  const t = (k: "gross" | "commission" | "fees" | "vatOnFees" | "net") =>
    roundMoney(sum(lines.map((l) => l[k])));
  const gross = t("gross");
  const commission = t("commission");
  const fees = t("fees");
  return {
    gross,
    commission,
    fees,
    vatOnFees: t("vatOnFees"),
    net: t("net"),
    /** Commission and fees as a share of gross, in percent (null without sales). */
    effectiveRate: gross.greaterThan(0)
      ? roundMoney(commission.plus(fees).dividedBy(gross).times(100))
      : null,
  };
}
