import "server-only";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import type { Prisma } from "@/generated/prisma/client";
import { hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import { PAUSING_REASONS } from "./pause-rules";
import { pausedProducts } from "./replenishment";
import { REJECTION_REASONS, type RejectionReason } from "./rules";

/**
 * Dropping single products from an agent's order suggestion (DECISIONS.md
 * ADR-156). A person who could order for the warehouse takes a line out with
 * a reason; the rest of the suggestion stays to be approved. Dropping a
 * product as not needed or already done twice within 30 days pauses it for
 * that warehouse (ADR-155 rules), until someone lets the agent propose it
 * again.
 */

type SuggestionLine = { sku: string; quantity: string; price: string } & Record<string, unknown>;

const dropSchema = z
  .object({
    sku: z.string().trim().min(1).max(60),
    reason: z.enum(REJECTION_REASONS, { error: "invalidOption" }),
    note: z.string().trim().max(500).optional(),
  })
  .refine((d) => d.reason !== "OTHER" || d.note, { path: ["note"], error: "required" });

async function mayOrderFor(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: { branchId: true },
  });
  return (
    !!wh &&
    hasPermission(ctx.grants, "purchasing.manage", {
      branchId: wh.branchId ?? undefined,
      warehouseId,
    })
  );
}

export async function dropProposalLine(ctx: TenantContext, proposalId: string, raw: unknown) {
  const parsed = dropSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const p = await tx.agentProposal.findFirst({
      where: { organizationId: ctx.organizationId, id: proposalId },
    });
    if (!p) throw notFound("Proposal");
    if (p.kind !== "REORDER" || !p.warehouseId)
      throw businessRuleViolation("PROPOSAL_NO_LINES", "Only order suggestions have lines to drop");
    if (!(await mayOrderFor(tx, ctx, p.warehouseId))) throw forbidden();
    if (p.status !== "OPEN")
      throw businessRuleViolation("PROPOSAL_DECIDED", "This proposal was already decided");
    const detail = p.detail as { lines?: SuggestionLine[]; ruleIds?: string[] } & Record<
      string,
      unknown
    >;
    const lines = detail.lines ?? [];
    const ruleIds = detail.ruleIds ?? [];
    const at = lines.findIndex((l) => l.sku === input.sku);
    if (at < 0) throw notFound("Line");
    if (lines.length === 1)
      throw businessRuleViolation(
        "PROPOSAL_LAST_LINE",
        "This is the only line; reject the suggestion instead",
      );
    const product = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, sku: input.sku },
      select: { id: true },
    });
    if (!product) throw notFound("Product");
    const kept = lines.filter((_, i) => i !== at);
    const total = kept.reduce(
      (a, l) => a.plus(new Decimal(l.quantity).times(l.price)),
      new Decimal(0),
    );
    const updated = await tx.agentProposal.updateMany({
      where: { id: p.id, status: "OPEN" },
      data: {
        detail: {
          ...detail,
          lines: kept,
          ruleIds: ruleIds.filter((_, i) => i !== at),
          total: total.toFixed(2),
        } as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 0)
      throw businessRuleViolation("PROPOSAL_DECIDED", "This proposal was already decided");
    const drop = await tx.agentLineDrop.create({
      data: {
        organizationId: ctx.organizationId,
        agentId: p.agentId,
        proposalId: p.id,
        warehouseId: p.warehouseId,
        productId: product.id,
        sku: input.sku,
        reason: input.reason,
        note: input.note || null,
        droppedByUserId: ctx.userId,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "agent.line_dropped",
      entityType: "agent_proposal",
      entityId: p.id,
      changes: { sku: input.sku, reason: input.reason, drop: drop.id },
    });
    return { dropId: drop.id, lines: kept.length };
  });
}

/** Products the replenishment agent holds back now, for those who may order for the warehouse. */
export async function pausedLines(ctx: TenantContext) {
  const paused = await pausedProducts(ctx);
  if (paused.size === 0) return [];
  return withTenantTx(ctx.organizationId, async (tx) => {
    const pairs = [...paused.keys()].map((k) => k.split(":") as [string, string]);
    const [warehouses, products] = await Promise.all([
      tx.warehouse.findMany({
        where: { organizationId: ctx.organizationId, id: { in: pairs.map((p) => p[0]) } },
        select: { id: true, code: true, branchId: true },
      }),
      tx.product.findMany({
        where: { organizationId: ctx.organizationId, id: { in: pairs.map((p) => p[1]) } },
        select: { id: true, sku: true, nameEn: true },
      }),
    ]);
    return pairs
      .flatMap(([warehouseId, productId]) => {
        const wh = warehouses.find((w) => w.id === warehouseId);
        const pr = products.find((x) => x.id === productId);
        if (
          !wh ||
          !pr ||
          !hasPermission(ctx.grants, "purchasing.manage", {
            branchId: wh.branchId ?? undefined,
            warehouseId,
          })
        )
          return [];
        return [
          {
            warehouseId,
            productId,
            warehouse: wh.code,
            sku: pr.sku,
            name: pr.nameEn,
            until: paused.get(`${warehouseId}:${productId}`)!,
          },
        ];
      })
      .sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.sku.localeCompare(b.sku));
  });
}

/** Let the agent propose a product for a warehouse again (ADR-156). */
export async function liftLinePause(ctx: TenantContext, warehouseId: string, productId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    if (!(await mayOrderFor(tx, ctx, warehouseId))) throw forbidden();
    const lifted = await tx.agentLineDrop.updateMany({
      where: {
        organizationId: ctx.organizationId,
        warehouseId,
        productId,
        agent: { kind: "REPLENISHMENT" },
        reason: { in: [...PAUSING_REASONS] as RejectionReason[] },
        pauseLiftedAt: null,
      },
      data: { pauseLiftedAt: new Date() },
    });
    if (lifted.count === 0)
      throw businessRuleViolation("PROPOSAL_NOT_PAUSING", "Nothing is paused for this product");
    await recordAudit(tx, actorOf(ctx), {
      action: "agent.line_pause_lifted",
      entityType: "warehouse",
      entityId: warehouseId,
      changes: { productId, drops: lifted.count },
    });
    return { lifted: lifted.count };
  });
}
