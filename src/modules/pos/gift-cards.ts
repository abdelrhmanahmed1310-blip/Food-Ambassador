import "server-only";
import { companyContext } from "@/modules/fx/service";
import { createHmac, randomInt } from "node:crypto";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { integrationKey } from "@/modules/integrations/crypto";
import { uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { giftCardCode, readGiftCardCode } from "./loyalty-rules";

/**
 * Gift cards (DECISIONS.md ADR-068): stored value sold at a register and
 * spent as a payment on later orders. Selling one is not a sale (no VAT, no
 * stock); VAT is charged on the order it pays for. The code is a bearer
 * secret: it is shown once when sold and kept only as a keyed hash.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

/** Keyed hash of a code (HMAC-SHA256), per organization. */
export function codeHash(organizationId: string, code: string) {
  const env = getEnv();
  const key = integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
  return createHmac("sha256", key).update(`gift-card:${organizationId}:${code}`).digest("hex");
}

const codeSchema = z.string().transform((v, c) => {
  const code = readGiftCardCode(v);
  if (!code) {
    c.addIssue({ code: "custom", message: "invalidGiftCard" });
    return z.NEVER;
  }
  return code;
});

const sellSchema = z.object({
  registerId: uuidSchema,
  amount: decimalString({ maxScale: 2, min: "1", max: "100000" }),
  method: z.enum(["CASH", "CARD"], { error: "invalidOption" }),
});

/** Sell a gift card at a register with an open shift; the money counts in that shift. */
export async function sellGiftCard(ctx: TenantContext, rawInput: unknown) {
  const parsed = sellSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    const register = await tx.posRegister.findFirst({
      where: { organizationId: org, id: v.registerId, archivedAt: null },
    });
    if (
      !register ||
      !hasPermission(ctx.grants, "pos.sell", {
        branchId: register.branchId,
        warehouseId: register.warehouseId,
      })
    )
      throw notFound("Register");
    const shift = await tx.posShift.findFirst({
      where: { organizationId: org, registerId: register.id, status: "OPEN" },
    });
    if (!shift)
      throw businessRuleViolation("SHIFT_NOT_OPEN", "Open a shift on this register first");
    // 15 random digits: a collision is retried (the hash is unique per organization).
    for (let attempt = 0; attempt < 5; attempt++) {
      const random = Array.from({ length: 15 }, () => String(randomInt(10))).join("");
      const code = giftCardCode(random);
      const hash = codeHash(org, code);
      if (await tx.giftCard.findFirst({ where: { organizationId: org, codeHash: hash } })) continue;
      const card = await tx.giftCard.create({
        data: {
          organizationId: org,
          codeHash: hash,
          last4: code.slice(-4),
          initialValue: v.amount,
          balance: v.amount,
          // In the register's company's currency; spent only where that currency is (ADR-086).
          currency: (await companyContext(tx, ctx, { branchId: register.branchId })).currency,
          shiftId: shift.id,
          soldMethod: v.method,
          soldByUserId: ctx.userId,
        },
        select: { id: true, last4: true, balance: true },
      });
      await tx.giftCardEntry.create({
        data: {
          organizationId: org,
          giftCardId: card.id,
          kind: "ISSUE",
          amount: v.amount,
          createdByUserId: ctx.userId,
        },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "gift_card.sold",
        entityType: "gift_card",
        entityId: card.id,
        changes: { last4: card.last4, amount: v.amount, method: v.method, shift: shift.id },
      });
      return { id: card.id, code, last4: card.last4, balance: dec(card.balance) };
    }
    throw new Error("Could not generate a unique gift card code");
  });
}

/** A gift card's balance, for the till (the code is the proof). */
export async function giftCardBalance(ctx: TenantContext, rawCode: unknown) {
  if (!holdsAnyGrant(ctx.grants, "pos.sell") && !hasPermission(ctx.grants, "payments.manage"))
    throw forbidden("You cannot look up gift cards");
  const code = codeSchema.safeParse(rawCode);
  if (!code.success) throw validationFailed(code.error);
  const card = await withTenantTx(ctx.organizationId, (tx) =>
    tx.giftCard.findFirst({
      where: {
        organizationId: ctx.organizationId,
        codeHash: codeHash(ctx.organizationId, code.data),
      },
      select: { last4: true, balance: true, blockedAt: true },
    }),
  );
  if (!card) throw notFound("Gift card");
  return {
    last4: card.last4,
    balance: dec(card.balance).toFixed(),
    blocked: card.blockedAt !== null,
  };
}

/** Spend from a gift card on an order, inside the order's transaction. */
export async function redeemGiftCardInTx(
  tx: Tx,
  ctx: TenantContext,
  rawCode: string,
  amount: Decimal,
  orderId: string,
  field: string,
) {
  const code = readGiftCardCode(rawCode);
  const org = ctx.organizationId;
  const unknown = () =>
    businessRuleViolation("GIFT_CARD_UNKNOWN", "This gift card is not valid", { field });
  if (!code) throw unknown();
  const hash = codeHash(org, code);
  await tx.$queryRaw`SELECT 1 FROM "gift_cards" WHERE "organization_id" = ${org}::uuid AND "code_hash" = ${hash} FOR UPDATE`;
  const card = await tx.giftCard.findFirst({ where: { organizationId: org, codeHash: hash } });
  if (!card || card.blockedAt) throw unknown();
  if (card.currency !== ctx.baseCurrency)
    throw businessRuleViolation(
      "GIFT_CARD_OTHER_CURRENCY",
      "This gift card is in another currency",
      { field, currency: card.currency },
    );
  if (dec(card.balance).lt(amount))
    throw businessRuleViolation("GIFT_CARD_BALANCE_LOW", "The gift card does not have this much", {
      field,
      balance: dec(card.balance).toFixed(),
    });
  await tx.giftCard.update({
    where: { id: card.id },
    data: { balance: dec(card.balance).minus(amount).toFixed() },
  });
  await tx.giftCardEntry.create({
    data: {
      organizationId: org,
      giftCardId: card.id,
      kind: "REDEEM",
      amount: amount.negated().toFixed(),
      orderId,
      createdByUserId: ctx.userId,
    },
  });
  return card.id;
}

/** A voided order's gift card payments go back on the cards. */
export async function reverseGiftCardsInTx(tx: Tx, ctx: TenantContext, orderId: string) {
  const org = ctx.organizationId;
  const spent = await tx.giftCardEntry.findMany({
    where: { organizationId: org, orderId, kind: "REDEEM" },
  });
  for (const e of spent) {
    await tx.$queryRaw`SELECT 1 FROM "gift_cards" WHERE "organization_id" = ${org}::uuid AND "id" = ${e.giftCardId}::uuid FOR UPDATE`;
    const card = await tx.giftCard.findUniqueOrThrow({ where: { id: e.giftCardId } });
    const back = dec(e.amount).negated();
    await tx.giftCard.update({
      where: { id: card.id },
      data: { balance: dec(card.balance).plus(back).toFixed() },
    });
    await tx.giftCardEntry.create({
      data: {
        organizationId: org,
        giftCardId: card.id,
        kind: "REVERSAL",
        amount: back.toFixed(),
        orderId,
        createdByUserId: ctx.userId,
      },
    });
  }
}

/** Stop a lost or stolen card being spent. */
export async function blockGiftCard(ctx: TenantContext, giftCardId: string) {
  assertPermission(ctx.grants, "payments.manage");
  const org = ctx.organizationId;
  await withTenantTx(org, async (tx) => {
    const card = await tx.giftCard.findFirst({ where: { organizationId: org, id: giftCardId } });
    if (!card) throw notFound("Gift card");
    if (card.blockedAt) return;
    await tx.giftCard.update({ where: { id: card.id }, data: { blockedAt: new Date() } });
    await recordAudit(tx, actorOf(ctx), {
      action: "gift_card.blocked",
      entityType: "gift_card",
      entityId: card.id,
      changes: { last4: card.last4, balance: dec(card.balance).toFixed() },
    });
  });
}

/** Gift cards and what is still owed on them (a liability). */
export async function listGiftCards(ctx: TenantContext) {
  assertPermission(ctx.grants, "payments.manage");
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    const [cards, owed] = await Promise.all([
      tx.giftCard.findMany({
        where: { organizationId: org },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          last4: true,
          initialValue: true,
          balance: true,
          soldMethod: true,
          createdAt: true,
          blockedAt: true,
          currency: true,
        },
      }),
      // Owed per currency: cards are in their selling company's currency (ADR-086).
      tx.giftCard.groupBy({
        by: ["currency"],
        where: { organizationId: org },
        _sum: { balance: true },
        orderBy: { currency: "asc" },
      }),
    ]);
    return {
      cards,
      owed: owed.map((o) => ({ currency: o.currency, amount: dec(o._sum.balance ?? 0) })),
    };
  });
}
