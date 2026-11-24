import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createEquipment, recordCalibration } from "@/modules/foodsafety/equipment";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import {
  addGoodsLine,
  createInvoice,
  getInvoice,
  postInvoice,
  updateInvoiceHeader,
} from "@/modules/invoices/service";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { getReceipt, postReceipt } from "@/modules/procurement/receipts";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { createSupplier } from "@/modules/procurement/suppliers";
import { addRecipePrice, listRecipePrices, updateRecipeSettings } from "@/modules/recipes/menu";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { explanationPayload } from "./explain-rules";
import type { AgentKindCode } from "./rules";
import { decideProposal, getRun, listProposals, runAgentNow, updateAgent } from "./service";

/** Invoice matching, food safety and menu & margin agents (ADR-142). */

let ctx: TenantContext;
let finance: TenantContext;
let units: Record<string, string>;
let branchId: string;
let warehouseId: string;
let supplierId: string;
let flour: string;
const today = () => businessDate(ctx.timeZone);

const switchOn = (kind: AgentKindCode, settings: Record<string, unknown> = {}) =>
  updateAgent(ctx, kind, { enabled: true, autonomy: "SUGGEST", runHour: "6", settings });

async function runNow(kind: AgentKindCode) {
  const r = await runAgentNow(ctx, kind);
  expect(r.error).toBeUndefined();
  return getRun(ctx, r.runId);
}

const open = async (who: TenantContext, kind: string) =>
  (await listProposals(who)).items.filter((p) => p.kind === kind);

beforeAll(async () => {
  ({ ctx } = await createTenant("more-agents"));
  finance = (await addMember(ctx, "finance", {}, "agents-finance")).ctx;
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branchId = (await createBranch(ctx, { code: "JED", name: "Jeddah", type: "RESTAURANT" })).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  supplierId = (await createSupplier(ctx, { code: "MILL", name: "Mill Co" })).id;
  await applyCountryPreset(ctx, "SA");
  const codes = Object.fromEntries((await getTaxSetup(ctx)).codes.map((c) => [c.code, c.id]));
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    pricesIncludeTax: "",
    defaultSalesTaxCodeId: codes.STD,
    defaultPurchaseTaxCodeId: codes.STD,
    vatNumber: "310122393500003",
  });
  await updateProcurementSettings(ctx, {
    overReceiptTolerancePercent: "0",
    invoicePriceTolerancePercent: "2",
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("invoice matching agent (ADR-142)", () => {
  it("works out the overcharge, proposes a credit request once, and the approver accepts with a note", async () => {
    // Ordered and received 50 kg at 10; billed at 12: 100 more than the order, before VAT.
    const { id: orderId } = await createOrder(ctx, { supplierId, warehouseId });
    await addOrderLine(ctx, orderId, {
      productId: flour,
      quantity: "50",
      unitPrice: "10",
      uomId: units.kg,
    });
    await submitOrder(ctx, orderId);
    const order = await getOrder(ctx, orderId);
    const receipt = await postReceipt(ctx, orderId, {
      lines: [{ purchaseOrderLineId: order.lines[0].id, receivedQuantity: "50", unitPrice: "10" }],
    });
    const receiptLine = (await getReceipt(ctx, receipt.id)).lines[0].id;
    const inv = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "MC-2001",
      invoiceDate: today(),
      printedGross: "700",
    });
    await addGoodsLine(ctx, inv.id, {
      receiptLineId: receiptLine,
      quantity: "50",
      unitPrice: "12",
    });

    await switchOn("INVOICE_MATCHING");
    const run = await runNow("INVOICE_MATCHING");
    expect(run.findings.map((f) => [f.code, f.params.amount ?? f.params.printed])).toEqual([
      ["INVOICE_TOTAL_MISMATCH", "700.00"],
      ["INVOICE_EXCEPTION", "100.00"],
    ]);
    // A printed total that does not add up is fixed first: no credit request yet.
    expect(await open(ctx, "CREDIT_REQUEST")).toEqual([]);
    await updateInvoiceHeader(ctx, inv.id, {
      supplierInvoiceNo: "MC-2001",
      invoiceDate: today(),
      printedGross: "690",
    });
    await runNow("INVOICE_MATCHING");
    const [proposal] = await open(ctx, "CREDIT_REQUEST");
    expect(proposal.detail).toMatchObject({
      invoiceNumber: inv.number,
      total: "100.00",
      currency: ctx.baseCurrency,
      lines: [expect.objectContaining({ reason: "PRICE", amount: "100.00", orderedPrice: "10" })],
    });
    // The same exception is not proposed again.
    await runNow("INVOICE_MATCHING");
    expect(await open(ctx, "CREDIT_REQUEST")).toHaveLength(1);

    // The person who entered the invoice may not approve its differences.
    await expectAppError(
      decideProposal(ctx, proposal.id, { decision: "APPROVE" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await decideProposal(finance, proposal.id, { decision: "APPROVE" });
    const view = await getInvoice(ctx, inv.id);
    expect(view.exceptionApprovedAt).not.toBeNull();
    expect(view.exceptionNote).toBe(
      `Credit note of 100.00 ${ctx.baseCurrency} requested from Mill Co for the differences (agent proposal).`,
    );
    expect(await open(ctx, "CREDIT_REQUEST")).toHaveLength(0);
    // Approved exceptions are no longer reported.
    const after = await runNow("INVOICE_MATCHING");
    expect(after.findings.filter((f) => f.code === "INVOICE_EXCEPTION")).toEqual([]);
    expect(after.proposals).toEqual([]);
    await postInvoice(ctx, inv.id);
    expect((await getInvoice(ctx, inv.id)).status).toBe("POSTED");
  });
});

describe("food safety agent (ADR-142)", () => {
  it("reports expired stock and overdue calibration and proposes non-conformances to raise", async () => {
    const milk = (
      await createProduct(ctx, {
        sku: "MILK",
        nameEn: "Milk",
        type: "RAW_MATERIAL",
        baseUomId: units.l,
        lotTracking: "LOT_AND_EXPIRY",
      })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId,
      productId: milk,
      lotCode: "M-OLD",
      expiresOn: addDays(today(), 5),
      quantity: "10",
      uomId: units.l,
      unitCost: "2",
    });
    await postOpeningBalance(ctx, {
      warehouseId,
      productId: milk,
      lotCode: "M-SOON",
      expiresOn: addDays(today(), 1),
      quantity: "4",
      uomId: units.l,
      unitCost: "2",
    });
    // The first lot expired yesterday.
    await getDb().inventoryLot.updateMany({
      where: { organizationId: ctx.organizationId, lotCode: "M-OLD" },
      data: { expiresOn: new Date(`${addDays(today(), -1)}T00:00:00Z`) },
    });
    const probe = await createEquipment(ctx, {
      branchId,
      code: "PROBE-1",
      name: "Probe thermometer",
      type: "THERMOMETER",
      calibrationIntervalDays: "30",
    });
    await recordCalibration(ctx, probe.id, {
      performedOn: addDays(today(), -40),
      performedBy: "Shift lead",
      result: "PASS",
    });

    await switchOn("FOOD_SAFETY", { expiringWithinDays: "2" });
    const run = await runNow("FOOD_SAFETY");
    const codes = run.findings.map((f) => `${f.severity}:${f.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "CRITICAL:EXPIRED_STOCK",
        "WARNING:CALIBRATION_OVERDUE",
        "INFO:EXPIRING_STOCK",
      ]),
    );
    expect(codes.indexOf("CRITICAL:EXPIRED_STOCK")).toBe(0);
    const proposals = await open(ctx, "RAISE_NC");
    expect(proposals.map((p) => (p.detail as { reason: string }).reason).sort()).toEqual([
      "CALIBRATION_OVERDUE",
      "EXPIRED_STOCK",
    ]);
    expect(proposals.every((p) => p.branchId === branchId)).toBe(true);

    // Approving raises the non-conformance with the approver's access; it is not proposed again.
    const expired = proposals.find(
      (p) => (p.detail as { reason: string }).reason === "EXPIRED_STOCK",
    )!;
    const r = await decideProposal(ctx, expired.id, { decision: "APPROVE" });
    const nc = await getDb().nonConformance.findUniqueOrThrow({
      where: { id: r.outcome.nonConformanceId as string },
    });
    expect([nc.severity, nc.branchId, nc.title]).toEqual([
      "HIGH",
      branchId,
      "Expired stock available: MILK lot M-OLD",
    ]);
    await runNow("FOOD_SAFETY");
    expect((await open(ctx, "RAISE_NC")).map((p) => p.id)).toEqual(
      proposals.filter((p) => p.id !== expired.id).map((p) => p.id),
    );
    // The open HIGH non-conformance is now reported too.
    const again = await runNow("FOOD_SAFETY");
    expect(again.findings.map((f) => f.code)).toContain("NC_OPEN");
  });
});

describe("menu & margin agent (ADR-142)", () => {
  it("proposes the price that meets the target, never prices incomplete costs, and sets it on approval", async () => {
    const tomato = (
      await createProduct(ctx, {
        sku: "TOMATO",
        nameEn: "Tomato",
        type: "RAW_MATERIAL",
        baseUomId: units.kg,
      })
    ).id;
    const butter = (
      await createProduct(ctx, {
        sku: "BUTTER",
        nameEn: "Butter",
        type: "RAW_MATERIAL",
        baseUomId: units.kg,
      })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId,
      productId: tomato,
      quantity: "10",
      uomId: units.kg,
      unitCost: "20",
    });
    const dish = async (code: string, productId: string, quantity: string) => {
      const r = await createRecipe(ctx, {
        code,
        name: code,
        type: "DISH",
        yieldQuantity: "1",
        yieldUomId: units.each,
        portions: "1",
      });
      await addIngredient(ctx, r!.versionId, {
        item: `product:${productId}`,
        quantity,
        uomId: units.kg,
      });
      await activateVersion(ctx, r!.versionId);
      return r!.id;
    };
    // Salad costs 10 a portion and sells at 25: 40 % against a 30 % target.
    const salad = await dish("SALAD", tomato, "0.5");
    await dish("SOUP", butter, "0.1");
    await addRecipePrice(ctx, salad, { price: "25", effectiveFrom: today() });
    await updateRecipeSettings(ctx, { targetPercent: "30" });

    await switchOn("MENU_MARGIN", { effectiveInDays: "2" });
    const run = await runNow("MENU_MARGIN");
    expect(run.findings.map((f) => f.code)).toEqual(["ABOVE_TARGET", "COST_INCOMPLETE"]);
    expect(run.findings[1].params).toMatchObject({ count: 1, dishes: "SOUP" });
    const [proposal] = await open(ctx, "PRICE_CHANGE");
    expect(proposal.detail).toMatchObject({
      dish: "SALAD",
      price: "25.00",
      newPrice: "33.34",
      foodCostPercent: "40.0",
      newFoodCostPercent: "30.0",
      targetPercent: "30.0",
    });
    // A person without recipe rights neither sees nor decides it.
    expect(await open(finance, "PRICE_CHANGE")).toEqual([]);
    await expectAppError(
      decideProposal(finance, proposal.id, { decision: "APPROVE" }),
      "FORBIDDEN",
    );

    await decideProposal(ctx, proposal.id, { decision: "APPROVE" });
    const prices = await listRecipePrices(ctx, salad);
    expect([
      prices[0].price.toString(),
      prices[0].effectiveFrom.toISOString().slice(0, 10),
    ]).toEqual(["33.34", addDays(today(), 2)]);
    // Not proposed again while the approved price is waiting to start.
    await runNow("MENU_MARGIN");
    expect(await open(ctx, "PRICE_CHANGE")).toEqual([]);
  });

  it("sends Claude business figures only, never record ids", async () => {
    const runs = await getDb().agentRun.findMany({
      where: { organizationId: ctx.organizationId, status: "SUCCEEDED" },
      include: { agent: true, proposals: true },
    });
    for (const r of runs) {
      const text = JSON.stringify(
        explanationPayload({
          kind: r.agent.kind as AgentKindCode,
          autonomy: r.agent.autonomy,
          businessDate: null,
          baseCurrency: "SAR",
          summary: r.summary as Record<string, unknown>,
          findings: r.findings as never,
          proposals: r.proposals,
        }),
      );
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
  });
});
