import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { setExchangeRate } from "@/modules/fx/service";
import { businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { blockSupplier } from "./compliance";
import { getOrder, submitOrder } from "./orders";
import {
  addRfqLine,
  awardRfq,
  cancelRfq,
  createRfq,
  getRfq,
  inviteRfqSupplier,
  listRfqs,
  recordQuotation,
  removeRfqLine,
  rfqForSupplier,
  sendRfq,
} from "./rfqs";
import { createSupplier } from "./suppliers";

/** Requests for quotation, comparison and award (ADR-092). */

let ctx: TenantContext; // owner
let buyer: TenantContext; // procurement
let analyst: TenantContext; // read-only
let warehouseId: string;
let flour: string;
let oil: string;
let units: Record<string, string>;
const suppliers: Record<string, string> = {};

const day = (offset: number) => {
  const d = new Date(`${businessDate(ctx.timeZone)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

let keys = 0;
const key = () => `rfq-test-${Date.now()}-${++keys}`;

async function expectRule(promise: Promise<unknown>, rule: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    expect(`${e.code}:${e.details?.rule}`).toBe(`BUSINESS_RULE_VIOLATION:${rule}`);
    return;
  }
  throw new Error(`Expected ${rule} but the call succeeded`);
}

/** A sent RFQ for 100 kg flour and 20 l oil, asked of the given suppliers. */
async function sentRfq(codes: string[]) {
  const { id } = await createRfq(buyer, {
    warehouseId,
    title: "Monthly dry goods",
    respondBy: day(3),
    neededBy: day(10),
    idempotencyKey: key(),
  });
  await addRfqLine(buyer, id, { productId: flour, uomId: units.kg, quantity: "100" });
  await addRfqLine(buyer, id, { productId: oil, uomId: units.l, quantity: "20" });
  for (const c of codes) await inviteRfqSupplier(buyer, id, { supplierId: suppliers[c] });
  await sendRfq(buyer, id);
  return id;
}

const lineIds = async (rfqId: string) => (await getRfq(buyer, rfqId)).lines.map((l) => l.id);

beforeAll(async () => {
  ({ ctx } = await createTenant("rfq"));
  buyer = (await addMember(ctx, "procurement")).ctx;
  analyst = (await addMember(ctx, "analyst")).ctx;
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
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
  oil = (
    await createProduct(ctx, {
      sku: "OIL",
      nameEn: "Oil",
      type: "RAW_MATERIAL",
      baseUomId: units.l,
    })
  ).id;
  for (const [code, currency] of [
    ["NILE", undefined],
    ["GLOBAL", "USD"],
    ["DELTA", undefined],
    ["EURO", "EUR"],
    ["BAD", undefined],
  ] as const)
    suppliers[code] = (await createSupplier(ctx, { code, name: code, currency })).id;
  await blockSupplier(ctx, suppliers.BAD, { reason: "Quality" });
  // 1 USD = 48 EGP today; no EUR rate.
  await setExchangeRate(ctx, { currency: "USD", rateDate: day(0), rate: "48" });
});

describe("drafting and sending (ADR-092)", () => {
  it("needs lines and suppliers, never a blocked one, then freezes them", async () => {
    const { id } = await createRfq(buyer, {
      warehouseId,
      title: "Oil",
      idempotencyKey: key(),
    });
    await expectRule(sendRfq(buyer, id), "RFQ_HAS_NO_LINES");
    const { id: lineId } = await addRfqLine(buyer, id, {
      productId: oil,
      uomId: units.l,
      quantity: "5",
    });
    await expectAppError(
      addRfqLine(buyer, id, { productId: oil, uomId: units.l, quantity: "1" }),
      "CONFLICT",
    );
    await expectAppError(
      addRfqLine(buyer, id, { productId: oil, uomId: units.kg, quantity: "1" }),
      "BUSINESS_RULE_VIOLATION", // kg does not convert to litres
    );
    await expectRule(sendRfq(buyer, id), "RFQ_HAS_NO_SUPPLIERS");
    await expectRule(
      inviteRfqSupplier(buyer, id, { supplierId: suppliers.BAD }),
      "SUPPLIER_BLOCKED",
    );
    await inviteRfqSupplier(buyer, id, { supplierId: suppliers.NILE });
    await expectAppError(
      inviteRfqSupplier(analyst, id, { supplierId: suppliers.DELTA }),
      "FORBIDDEN",
    );
    await sendRfq(buyer, id);
    await expectRule(removeRfqLine(buyer, id, lineId), "RFQ_STATUS");
    await expectRule(inviteRfqSupplier(buyer, id, { supplierId: suppliers.DELTA }), "RFQ_STATUS");

    const pdf = await rfqForSupplier(buyer, id, suppliers.NILE);
    expect(pdf.lines).toHaveLength(1);
    await expectAppError(rfqForSupplier(buyer, id, suppliers.DELTA), "NOT_FOUND");

    await expectAppError(cancelRfq(buyer, id, { reason: "" }), "VALIDATION_FAILED");
    await cancelRfq(buyer, id, { reason: "Bought locally" });
    expect((await getRfq(analyst, id)).rfq.status).toBe("CANCELLED");
    expect((await listRfqs(buyer, { status: "CANCELLED" })).items.map((r) => r.id)).toContain(id);
  });

  it("is invisible to other organizations", async () => {
    const id = await sentRfq(["NILE"]);
    const { ctx: other } = await createTenant("rfq-other");
    await expectAppError(getRfq(other, id), "NOT_FOUND");
    expect((await listRfqs(other)).total).toBe(0);
  });
});

describe("quotations, comparison and award (ADR-092)", () => {
  it("compares offers in the company currency and awards them into draft orders", async () => {
    const id = await sentRfq(["NILE", "GLOBAL", "DELTA"]);
    const [flourLine, oilLine] = await lineIds(id);

    await expectRule(
      recordQuotation(buyer, id, {
        supplierId: suppliers.EURO,
        quotedOn: day(0),
        lines: [{ rfqLineId: flourLine, unitPrice: "1" }],
      }),
      "SUPPLIER_NOT_ASKED",
    );
    await expectRule(
      recordQuotation(buyer, id, { supplierId: suppliers.NILE, quotedOn: day(0), lines: [] }),
      "QUOTATION_HAS_NO_PRICES",
    );
    // NILE (EGP): flour 10, oil 50.
    await recordQuotation(buyer, id, {
      supplierId: suppliers.NILE,
      reference: "NM-881",
      quotedOn: day(0),
      validUntil: day(30),
      lines: [
        { rfqLineId: flourLine, unitPrice: "11" },
        { rfqLineId: oilLine, unitPrice: "50" },
      ],
    });
    // A correction replaces the lines.
    await recordQuotation(buyer, id, {
      supplierId: suppliers.NILE,
      reference: "NM-881",
      quotedOn: day(0),
      validUntil: day(30),
      lines: [
        { rfqLineId: flourLine, unitPrice: "10" },
        { rfqLineId: oilLine, unitPrice: "50" },
      ],
    });
    // GLOBAL (USD by default): flour 0.19 USD = 9.12 EGP, only 60 kg.
    await recordQuotation(buyer, id, {
      supplierId: suppliers.GLOBAL,
      quotedOn: day(0),
      lines: [{ rfqLineId: flourLine, unitPrice: "0.19", quantity: "60" }],
    });
    // DELTA: oil cheaper, but the quotation has expired.
    await recordQuotation(buyer, id, {
      supplierId: suppliers.DELTA,
      quotedOn: day(-20),
      validUntil: day(-1),
      lines: [{ rfqLineId: oilLine, unitPrice: "40" }],
    });

    const view = await getRfq(analyst, id);
    expect(view.currency).toBe("EGP");
    expect(view.quotations.map((q) => q.currency).sort()).toEqual(["EGP", "EGP", "USD"]);
    const flourOffers = view.lines[0].offers;
    const global = flourOffers.find((o) => o.quotationId === view.quotations[1].id)!;
    expect(global.comparable!.toFixed()).toBe("912"); // 0.19 × 100 kg × 48
    expect(global.lowest).toBe(true);
    const oilOffers = view.lines[1].offers;
    expect(oilOffers.find((o) => o.expired)!.lowest).toBe(false); // expired DELTA is not lowest
    expect(oilOffers.find((o) => !o.expired)!.lowest).toBe(true);
    const nile = view.quotations.find((q) => q.supplier.id === suppliers.NILE)!;
    expect(nile.complete).toBe(true);
    expect(nile.total!.toFixed()).toBe("2000"); // 1000 + 1000
    expect(view.quotations.find((q) => q.supplier.id === suppliers.GLOBAL)!.complete).toBe(false);

    const nileFlour = flourOffers.find((o) => o.quotationId === nile.id)!;
    const nileOil = oilOffers.find((o) => o.quotationId === nile.id)!;
    const deltaOil = oilOffers.find((o) => o.expired)!;
    await expectAppError(awardRfq(analyst, id, { lines: [], idempotencyKey: key() }), "FORBIDDEN");
    await expectRule(
      awardRfq(buyer, id, { lines: [{ rfqLineId: flourLine }], idempotencyKey: key() }),
      "NOTHING_AWARDED",
    );
    // The dearer NILE flour needs a reason.
    await expectRule(
      awardRfq(buyer, id, {
        lines: [{ rfqLineId: flourLine, quotationLineId: nileFlour.quotationLineId }],
        idempotencyKey: key(),
      }),
      "AWARD_REASON_REQUIRED",
    );
    await expectRule(
      awardRfq(buyer, id, {
        lines: [{ rfqLineId: oilLine, quotationLineId: deltaOil.quotationLineId }],
        idempotencyKey: key(),
      }),
      "QUOTATION_EXPIRED",
    );

    // Flour from GLOBAL (lowest, 60 kg offered), oil from NILE.
    const { orders } = await awardRfq(buyer, id, {
      expectedOn: day(10),
      lines: [
        { rfqLineId: flourLine, quotationLineId: global.quotationLineId },
        { rfqLineId: oilLine, quotationLineId: nileOil.quotationLineId },
      ],
      idempotencyKey: key(),
    });
    expect(orders).toHaveLength(2);
    const pos = await Promise.all(orders.map((o) => getOrder(buyer, o.id)));
    const usd = pos.find((p) => p.currency === "USD")!;
    expect(usd.status).toBe("DRAFT");
    expect(usd.supplierId).toBe(suppliers.GLOBAL);
    expect(usd.lines.map((l) => [l.quantity.toFixed(), l.unitPrice.toFixed()])).toEqual([
      ["60", "0.19"],
    ]);
    const egp = pos.find((p) => p.currency === "EGP")!;
    expect(egp.lines.map((l) => [l.quantity.toFixed(), l.unitPrice.toFixed()])).toEqual([
      ["20", "50"],
    ]);
    expect((await submitOrder(buyer, egp.id)).status).toBe("APPROVED");

    const after = await getRfq(buyer, id);
    expect(after.rfq.status).toBe("AWARDED");
    expect(after.orders).toHaveLength(2);
    await expectRule(
      awardRfq(buyer, id, {
        lines: [{ rfqLineId: oilLine, quotationLineId: nileOil.quotationLineId }],
        idempotencyKey: key(),
      }),
      "RFQ_STATUS",
    );
  });

  it("asks for a reason when an offer cannot be compared for want of a rate", async () => {
    const id = await sentRfq(["NILE", "EURO"]);
    const [flourLine] = await lineIds(id);
    for (const [code, price] of [
      ["NILE", "10"],
      ["EURO", "0.1"],
    ] as const)
      await recordQuotation(buyer, id, {
        supplierId: suppliers[code],
        quotedOn: day(0),
        lines: [{ rfqLineId: flourLine, unitPrice: price }],
      });
    const view = await getRfq(buyer, id);
    expect(view.missingRates).toEqual(["EUR"]);
    const [nile, euro] = view.lines[0].offers;
    expect(euro.comparable).toBeNull();
    expect(nile.needsReason).toBe(true);
    await expectRule(
      awardRfq(buyer, id, {
        lines: [{ rfqLineId: flourLine, quotationLineId: nile.quotationLineId }],
        idempotencyKey: key(),
      }),
      "AWARD_REASON_REQUIRED",
    );
    await awardRfq(buyer, id, {
      lines: [
        {
          rfqLineId: flourLine,
          quotationLineId: nile.quotationLineId,
          reason: "Local supplier, EUR offer excludes freight",
        },
      ],
      idempotencyKey: key(),
    });
    const line = await getDb().rfqLine.findUniqueOrThrow({ where: { id: flourLine } });
    expect(line.awardReason).toBe("Local supplier, EUR offer excludes freight");
  });

  it("still refuses a supplier blocked after quoting, and checks quotes in the database", async () => {
    const pending = (await createSupplier(buyer, { code: "LATE", name: "Late" })).id;
    suppliers.LATE = pending;
    const id = await sentRfq(["NILE", "LATE"]);
    const [flourLine] = await lineIds(id);
    await recordQuotation(buyer, id, {
      supplierId: pending,
      quotedOn: day(0),
      lines: [{ rfqLineId: flourLine, unitPrice: "5" }],
    });
    const offer = (await getRfq(buyer, id)).lines[0].offers[0];
    await blockSupplier(ctx, pending, { reason: "Licence revoked" });
    await expectRule(
      awardRfq(buyer, id, {
        lines: [{ rfqLineId: flourLine, quotationLineId: offer.quotationLineId }],
        idempotencyKey: key(),
      }),
      "SUPPLIER_BLOCKED",
    );
    // A quotation can only come from an invited supplier.
    await expect(
      getDb().quotation.create({
        data: {
          organizationId: ctx.organizationId,
          rfqId: id,
          supplierId: suppliers.DELTA,
          currency: "EGP",
          quotedOn: new Date(),
          createdByUserId: ctx.userId,
        },
      }),
    ).rejects.toThrow(/not asked to quote/);
  });
});
