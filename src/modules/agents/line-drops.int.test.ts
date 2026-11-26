import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { saveReorderRule } from "@/modules/procurement/reorder";
import { createSupplier, saveSupplierProduct } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { dropProposalLine, liftLinePause, liftLinePauseByCodes, pausedLines } from "./line-drops";
import { getRun, runAgentNow, updateAgent } from "./service";

/** Dropping products from order suggestions; repeated drops pause them (ADR-156). */

let ctx: TenantContext;
let kitchen: string;
let rice: string;

const suggestion = () =>
  getDb().agentProposal.findFirst({
    where: { organizationId: ctx.organizationId, status: "OPEN", kind: "REORDER" },
  });
const skus = (p: { detail: unknown } | null) =>
  ((p?.detail as { lines?: Array<{ sku: string }> })?.lines ?? []).map((l) => l.sku).sort();

beforeAll(async () => {
  ({ ctx } = await createTenant("agent-line-drops"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const mills = (await createSupplier(ctx, { code: "MILLS", name: "Mills" })).id;
  const ids: Record<string, string> = {};
  for (const sku of ["RICE", "FLOUR"]) {
    ids[sku] = (
      await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId: units.kg })
    ).id;
    await saveSupplierProduct(ctx, mills, {
      productId: ids[sku],
      purchaseUomId: units.kg,
      lastUnitPrice: "40",
      preferred: "on",
    });
    await saveReorderRule(ctx, {
      warehouseId: kitchen,
      productId: ids[sku],
      uomId: units.kg,
      minQuantity: "10",
      maxQuantity: "50",
    });
  }
  rice = ids.RICE;
  await updateAgent(ctx, "REPLENISHMENT", {
    enabled: true,
    autonomy: "SUGGEST",
    runHour: "6",
    settings: { basis: "MIN_MAX" },
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("drop lines from order suggestions (ADR-156)", () => {
  it("drops a product with a reason, pauses it after two drops, and lifts the pause", async () => {
    await runAgentNow(ctx, "REPLENISHMENT");
    const first = (await suggestion())!;
    expect(skus(first)).toEqual(["FLOUR", "RICE"]);
    expect((first.detail as { total: string }).total).toBe("4000.00");

    // A reason is needed, OTHER with a note; only someone who orders for the warehouse.
    await expectAppError(dropProposalLine(ctx, first.id, { sku: "RICE" }), "VALIDATION_FAILED");
    await expectAppError(
      dropProposalLine(ctx, first.id, { sku: "RICE", reason: "OTHER" }),
      "VALIDATION_FAILED",
    );
    const analyst = (await addMember(ctx, "analyst", {}, "drops-analyst")).ctx;
    await expectAppError(
      dropProposalLine(analyst, first.id, { sku: "RICE", reason: "NOT_NEEDED" }),
      "FORBIDDEN",
    );
    expect(
      await dropProposalLine(ctx, first.id, { sku: "RICE", reason: "NOT_NEEDED" }),
    ).toMatchObject({ lines: 1 });
    const after = await getDb().agentProposal.findUniqueOrThrow({ where: { id: first.id } });
    expect(skus(after)).toEqual(["FLOUR"]);
    expect((after.detail as { ruleIds: string[]; total: string }).ruleIds).toHaveLength(1);
    expect((after.detail as { total: string }).total).toBe("2000.00");
    // The last line is rejected, not dropped.
    await expectAppError(
      dropProposalLine(ctx, first.id, { sku: "FLOUR", reason: "NOT_NEEDED" }),
      "BUSINESS_RULE_VIOLATION",
    );

    // One drop does not pause it: the next suggestion has rice again.
    await runAgentNow(ctx, "REPLENISHMENT");
    const second = (await suggestion())!;
    expect(skus(second)).toEqual(["FLOUR", "RICE"]);
    await dropProposalLine(ctx, second.id, { sku: "RICE", reason: "ALREADY_DONE" });
    expect(await pausedLines(ctx)).toEqual([
      expect.objectContaining({ warehouse: "KIT", sku: "RICE", productId: rice }),
    ]);
    expect(await pausedLines(analyst)).toEqual([]);

    // Two drops: rice is left out, and the run says so.
    const paused = await runAgentNow(ctx, "REPLENISHMENT");
    expect(skus(await suggestion())).toEqual(["FLOUR"]);
    expect((await getRun(ctx, paused.runId)).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PAUSED_LINES", params: { count: 1 } }),
      ]),
    );

    await expectAppError(liftLinePause(analyst, kitchen, rice), "FORBIDDEN");
    // By codes, as outside agents do (ADR-161).
    await expectAppError(liftLinePauseByCodes(ctx, "KIT", "NOPE"), "NOT_FOUND");
    expect(await liftLinePauseByCodes(ctx, "KIT", "RICE")).toEqual({ lifted: 2 });
    expect(await pausedLines(ctx)).toEqual([]);
    await expectAppError(liftLinePause(ctx, kitchen, rice), "BUSINESS_RULE_VIOLATION");
    await runAgentNow(ctx, "REPLENISHMENT");
    expect(skus(await suggestion())).toEqual(["FLOUR", "RICE"]);
    expect(
      await getDb().auditEvent.count({
        where: { organizationId: ctx.organizationId, action: "agent.line_dropped" },
      }),
    ).toBe(2);
  });
});
