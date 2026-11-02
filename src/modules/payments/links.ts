import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { decryptSecret, encryptSecret, integrationKey } from "@/modules/integrations/crypto";
import { applyDiscounts } from "@/modules/pos/discounts";
import { lineAmounts } from "@/modules/pos/rules";
import { getTab, payTab } from "@/modules/pos/tables";
import { uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { AppError, businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { createInvoice, getInvoice, ProviderError, type Fetch } from "./moyasar";

/**
 * Pay by QR at the table (DECISIONS.md ADR-066): a payment link for all or
 * part of a check, paid on the guest's phone (mada, Apple Pay, cards) at
 * Moyasar, and recorded as an ordinary card payment of the check once the
 * provider confirms it.
 */

const key = () => {
  const env = getEnv();
  return integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
};
const dec = (v: { toString(): string }) => new Decimal(v.toString());

const providerSchema = z
  .object({
    mode: z.enum(["TEST", "LIVE"], { error: "invalidOption" }),
    secretKey: z.string().trim().min(10, { error: "invalid" }).max(200),
  })
  .refine((v) => v.secretKey.startsWith(v.mode === "TEST" ? "sk_test_" : "sk_live_"), {
    error: "secretKeyMode",
    path: ["secretKey"],
  });

/** Save the Moyasar secret key (sealed; never shown again). */
export async function savePaymentProvider(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = providerSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const data = {
    mode: parsed.data.mode,
    secretKeySealed: encryptSecret(parsed.data.secretKey, key()),
  };
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.paymentProviderSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "payment_provider.saved",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { provider: "MOYASAR", mode: data.mode },
    });
  });
}

export async function paymentProvider(ctx: TenantContext) {
  const s = await withTenantTx(ctx.organizationId, (tx) =>
    tx.paymentProviderSettings.findUnique({
      where: { organizationId: ctx.organizationId },
      select: { provider: true, mode: true, updatedAt: true },
    }),
  );
  return s;
}

async function secretKey(ctx: TenantContext) {
  const s = await withTenantTx(ctx.organizationId, (tx) =>
    tx.paymentProviderSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
  );
  if (!s) throw businessRuleViolation("PAYMENT_PROVIDER_MISSING", "Set up online payments first");
  return decryptSecret(s.secretKeySealed, key());
}

const linkSchema = z.object({
  registerId: uuidSchema,
  lines: z
    .array(
      z.object({
        tabLineId: uuidSchema,
        quantity: decimalString({ maxScale: 3, min: "0.001", max: "999" }),
      }),
    )
    .max(200)
    .default([]),
  /** The total the screen showed; refused if the server's differs. Optional only for the server's own links. */
  expectedTotal: decimalString({ maxScale: 4, min: "0.01" }).optional(),
});

const providerFailed = (error: unknown) =>
  error instanceof ProviderError
    ? businessRuleViolation(
        "PAYMENT_PROVIDER_FAILED",
        "The payment provider did not accept the request",
        {
          status: error.status ?? 0,
        },
      )
    : error;

/** A payment link (QR) for the chosen items of a check, or everything left. */
export async function createPaymentLink(
  ctx: TenantContext,
  tabId: string,
  rawInput: unknown,
  fetchImpl: Fetch = fetch,
  /** Online ordering (ADR-071): the server prices the whole order and sets where the guest returns. */
  guest?: { callbackUrl: string; expiresAt: Date },
) {
  const parsed = linkSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  if (!guest && input.expectedTotal === undefined)
    throw validationFailed(
      new z.ZodError([
        { code: "custom", path: ["expectedTotal"], message: "required", input: undefined },
      ]),
    );
  const tab = await getTab(ctx, tabId);
  if (tab.status !== "OPEN") throw businessRuleViolation("CHECK_CLOSED", "This check is closed");
  const register = tab.registers.find((r) => r.id === input.registerId);
  if (
    !register ||
    !hasPermission(ctx.grants, "pos.sell", {
      branchId: tab.branchId,
      warehouseId: register.warehouseId,
    })
  )
    throw notFound("Register");
  // The amount the server charges, as the check screen computes it.
  const chosen =
    input.lines.length > 0
      ? input.lines.map((l) => {
          const line = tab.lines.find((x) => x.id === l.tabLineId);
          if (!line || dec(l.quantity).gt(line.remaining))
            throw businessRuleViolation("CHECK_ITEM_OVERPAID", "More than is left on this item");
          return { line, quantity: dec(l.quantity) };
        })
      : tab.lines.filter((l) => l.remaining.gt(0)).map((l) => ({ line: l, quantity: l.remaining }));
  if (chosen.length === 0) throw businessRuleViolation("NOTHING_TO_PAY", "Nothing is left to pay");
  for (const c of chosen)
    if (!c.line.unitPrice)
      throw businessRuleViolation("MENU_ITEM_NOT_SOLD", "An item is not on sale");
  // As the order will be priced: promotions on the items, no order discount (ADR-067).
  const total = applyDiscounts(
    chosen.map((c) => ({
      gross: lineAmounts(
        c.line.unitPrice!,
        c.quantity,
        c.line.includesTax ?? true,
        c.line.taxRate === null ? null : dec(c.line.taxRate),
        ctx.baseCurrency,
      ).gross,
      rate: c.line.taxRate === null ? null : dec(c.line.taxRate),
      promoPercent: c.line.promotion ? dec(c.line.promotion.percent) : null,
    })),
    null,
    ctx.baseCurrency,
  ).lines.reduce((a, l) => a.plus(l.gross), new Decimal(0));
  if (total.isZero()) throw businessRuleViolation("NOTHING_TO_PAY", "Nothing is left to pay");
  if (input.expectedTotal !== undefined && !total.equals(dec(input.expectedTotal)))
    throw businessRuleViolation("ORDER_PRICES_CHANGED", "Prices changed; refresh the check", {
      total: total.toFixed(),
    });
  const orderId = randomUUID();
  const invoice = await createInvoice(fetchImpl, await secretKey(ctx), {
    amount: total,
    currency: ctx.baseCurrency,
    description: `${tab.table?.code ?? tab.label ?? ""} ${tab.number}`.trim(),
    metadata: { organization: ctx.organizationSlug, check: tab.number, order: orderId },
    ...(guest ? { callbackUrl: guest.callbackUrl, expiresAt: guest.expiresAt } : {}),
  }).catch((e) => {
    throw providerFailed(e);
  });
  return withTenantTx(ctx.organizationId, async (tx) => {
    const link = await tx.paymentLink.create({
      data: {
        organizationId: ctx.organizationId,
        provider: "MOYASAR",
        providerInvoiceId: invoice.id,
        url: invoice.url,
        tabId: tab.id,
        registerId: register.id,
        orderId,
        lines: input.lines,
        amount: total.toFixed(),
        currency: ctx.baseCurrency,
        createdByUserId: ctx.userId,
      },
      select: { id: true, url: true, amount: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "payment_link.created",
      entityType: "pos_tab",
      entityId: tab.id,
      changes: { link: link.id, amount: total.toFixed() },
    });
    return link;
  });
}

async function loadLink(ctx: TenantContext, linkId: string) {
  const link = await withTenantTx(ctx.organizationId, (tx) =>
    tx.paymentLink.findFirst({ where: { organizationId: ctx.organizationId, id: linkId } }),
  );
  if (!link) throw notFound("Payment link");
  await getTab(ctx, link.tabId); // visible to this user?
  return link;
}

/**
 * Ask the provider whether the link is paid; when it is, record the payment
 * on the check (once — the order id is fixed on the link). A paid link that
 * cannot be recorded keeps the reason for a manager.
 */
export async function refreshPaymentLink(
  ctx: TenantContext,
  linkId: string,
  fetchImpl: Fetch = fetch,
) {
  let link = await loadLink(ctx, linkId);
  if (link.status === "CREATED") {
    const state = await getInvoice(fetchImpl, await secretKey(ctx), link.providerInvoiceId).catch(
      (e) => {
        throw providerFailed(e);
      },
    );
    if (state.state === "PENDING") return link;
    if (state.state === "FAILED" || state.state === "CANCELLED") {
      return withTenantTx(ctx.organizationId, (tx) =>
        tx.paymentLink.update({
          where: { id: link.id },
          data: { status: state.state === "FAILED" ? "FAILED" : "CANCELLED" },
        }),
      );
    }
    const expected = dec(link.amount).times(100).toNumber();
    if (state.amountMinor !== null && state.amountMinor !== expected) {
      await withTenantTx(ctx.organizationId, (tx) =>
        tx.paymentLink.update({
          where: { id: link.id },
          data: { problem: "PAYMENT_AMOUNT_DIFFERS" },
        }),
      );
      throw businessRuleViolation("PAYMENT_AMOUNT_DIFFERS", "The provider reports another amount");
    }
    link = await withTenantTx(ctx.organizationId, (tx) =>
      tx.paymentLink.update({
        where: { id: link.id },
        data: {
          status: "PAID",
          paidAt: new Date(),
          providerPaymentId: state.payment?.id ?? null,
          cardScheme: state.payment?.scheme ?? "OTHER",
          cardLast4: state.payment?.last4 ?? null,
        },
      }),
    );
  }
  if (link.status !== "PAID") return link;
  try {
    const order = await payTab(ctx, link.tabId, {
      orderId: link.orderId,
      registerId: link.registerId,
      lines: link.lines,
      payments: [
        {
          method: "CARD",
          amount: dec(link.amount).toFixed(),
          cardScheme: link.cardScheme ?? "OTHER",
          ...(link.cardLast4 ? { cardLast4: link.cardLast4 } : {}),
          reference: link.providerPaymentId
            ? `moyasar:${link.providerPaymentId}`.slice(0, 60)
            : undefined,
        },
      ],
      expectedTotal: dec(link.amount).toFixed(),
    });
    return withTenantTx(ctx.organizationId, (tx) =>
      tx.paymentLink
        .update({ where: { id: link.id }, data: { status: "RECORDED", problem: null } })
        .then((l) => ({ ...l, orderNumber: order.number })),
    );
  } catch (error) {
    const reason =
      error instanceof AppError ? String(error.details?.rule ?? error.code) : "INTERNAL";
    await withTenantTx(ctx.organizationId, (tx) =>
      tx.paymentLink.update({
        where: { id: link.id },
        data: { problem: reason },
      }),
    );
    throw error;
  }
}

/** Stop offering a link that was not paid (tell the guest not to use it). */
export async function cancelPaymentLink(ctx: TenantContext, linkId: string) {
  const link = await loadLink(ctx, linkId);
  if (link.status !== "CREATED")
    throw businessRuleViolation("PAYMENT_LINK_DONE", "This link is no longer open");
  await withTenantTx(ctx.organizationId, (tx) =>
    tx.paymentLink.update({ where: { id: link.id }, data: { status: "CANCELLED" } }),
  );
}

export async function linksForTab(ctx: TenantContext, tabId: string) {
  await getTab(ctx, tabId);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.paymentLink.findMany({
      where: { organizationId: ctx.organizationId, tabId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  );
}
