import { Decimal } from "@/lib/decimal";
import { currencyDecimals } from "@/modules/tax/rules";

/**
 * Moyasar (Saudi payment gateway, SAMA-licensed) — invoices API for
 * pay-by-QR at the table (DECISIONS.md ADR-066). `fetch` is passed in.
 *
 * NOT YET TESTED against Moyasar: the development environment's network
 * policy blocks api.moyasar.com. Requests follow Moyasar's REST API v1
 * (Basic auth with the secret key, amounts in the smallest currency unit).
 */

export const MOYASAR_API = "https://api.moyasar.com/v1";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** 115.50 SAR → 11550 (halalas). */
export function toMinorUnits(amount: Decimal, currency: string): number {
  const scaled = amount.times(new Decimal(10).pow(currencyDecimals(currency)));
  if (!scaled.isInteger()) throw new RangeError("Amount has more decimals than the currency");
  return scaled.toNumber();
}

export class ProviderError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: unknown,
  ) {
    super(`Payment provider answered ${status ?? "no response"}`);
  }
}

async function call(fetchImpl: Fetch, secretKey: string, path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetchImpl(`${MOYASAR_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderError(null, null);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new ProviderError(res.status, body);
  return body ?? {};
}

export async function createInvoice(
  fetchImpl: Fetch,
  secretKey: string,
  input: {
    amount: Decimal;
    currency: string;
    description: string;
    metadata: Record<string, string>;
    /** Where the guest returns after paying (online ordering, ADR-071). */
    callbackUrl?: string;
    /** After this the invoice can no longer be paid. */
    expiresAt?: Date;
  },
): Promise<{ id: string; url: string }> {
  const body = await call(fetchImpl, secretKey, "/invoices", {
    method: "POST",
    body: JSON.stringify({
      amount: toMinorUnits(input.amount, input.currency),
      currency: input.currency,
      description: input.description,
      metadata: input.metadata,
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      ...(input.expiresAt ? { expired_at: input.expiresAt.toISOString() } : {}),
    }),
  });
  if (typeof body.id !== "string" || typeof body.url !== "string")
    throw new ProviderError(200, body);
  return { id: body.id, url: body.url };
}

export type InvoiceState = "PENDING" | "PAID" | "FAILED" | "CANCELLED";

const SCHEMES: Record<string, "MADA" | "VISA" | "MASTERCARD" | "AMEX"> = {
  mada: "MADA",
  visa: "VISA",
  master: "MASTERCARD",
  mastercard: "MASTERCARD",
  amex: "AMEX",
};

/** What an invoice's state means here, and the paying card when paid (pure). */
export function readInvoice(body: Record<string, unknown>): {
  state: InvoiceState;
  amountMinor: number | null;
  payment: {
    id: string;
    scheme: "MADA" | "VISA" | "MASTERCARD" | "AMEX" | "OTHER";
    last4: string | null;
  } | null;
} {
  const status = String(body.status ?? "");
  const state: InvoiceState =
    status === "paid"
      ? "PAID"
      : status === "failed"
        ? "FAILED"
        : status === "canceled" || status === "expired"
          ? "CANCELLED"
          : "PENDING";
  const payments = Array.isArray(body.payments)
    ? (body.payments as Array<Record<string, unknown>>)
    : [];
  const paid = payments.find((p) => p.status === "paid");
  const source = (paid?.source ?? {}) as Record<string, unknown>;
  const digits = String(source.number ?? "").replace(/\D/g, "");
  return {
    state,
    amountMinor: typeof body.amount === "number" ? body.amount : null,
    payment: paid
      ? {
          id: String(paid.id),
          scheme: SCHEMES[String(source.company ?? "").toLowerCase()] ?? "OTHER",
          last4: digits.length >= 4 ? digits.slice(-4) : null,
        }
      : null,
  };
}

export async function getInvoice(fetchImpl: Fetch, secretKey: string, id: string) {
  return readInvoice(await call(fetchImpl, secretKey, `/invoices/${encodeURIComponent(id)}`));
}
