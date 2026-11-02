/**
 * DEVELOPMENT / DEMO SEED — a "[DEMO]" burger restaurant in Riyadh so the
 * point-of-sale screens, the dashboard and the guest ordering page have
 * something to show. Built only through the real services (tax, menu,
 * registers, tables, promotions, orders), so the data obeys every rule:
 * stock is used through the ledger, VAT is computed, orders are audited.
 * Idempotent: skipped when the branch RUH-BRG exists.
 */
import { randomUUID } from "node:crypto";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addEmployeeDocument, createDepartment, createEmployee } from "@/modules/hr/service";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { saveLoyaltySettings } from "@/modules/pos/customers";
import { createStation } from "@/modules/pos/kitchen";
import { createOrderingChannel } from "@/modules/pos/ordering";
import { createPromotion } from "@/modules/pos/promotions";
import { createRegister, openShift, submitOrder } from "@/modules/pos/service";
import { createFloor, createTable } from "@/modules/pos/tables";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";

const TZ = "Asia/Riyadh";

/** [code, name, Arabic name, category, price incl. VAT (SAR), unit cost of the kit (SAR)] */
const MENU = [
  ["BRG-CLS", "Classic burger", "برجر كلاسيك", "Burgers", "28", "9.5"],
  ["BRG-CHS", "Cheese burger", "برجر بالجبن", "Burgers", "32", "11"],
  ["BRG-CHK", "Crispy chicken burger", "برجر دجاج مقرمش", "Burgers", "26", "8.2"],
  ["SD-FRY", "Fries", "بطاطس مقلية", "Sides", "9", "2.4"],
  ["SD-RNG", "Onion rings", "حلقات البصل", "Sides", "12", "3.1"],
  ["DR-COLA", "Cola", "كولا", "Drinks", "6", "1.8"],
  ["DR-WTR", "Water", "مياه", "Drinks", "3", "0.6"],
] as const;

export async function seedRestaurant(ctx: TenantContext) {
  const db = getDb();
  if (
    await db.branch.findFirst({ where: { organizationId: ctx.organizationId, code: "RUH-BRG" } })
  ) {
    console.log("  [DEMO] burger restaurant: present");
    return;
  }
  const today = businessDate(TZ);

  // Saudi VAT (15 %, prices include VAT), with ZATCA's published sample VAT number.
  const tax = await getTaxSetup(ctx);
  if (!tax.settings) {
    await applyCountryPreset(ctx, "SA");
    const codes = Object.fromEntries((await getTaxSetup(ctx)).codes.map((c) => [c.code, c.id]));
    await updateTaxSettings(ctx, {
      country: "SA",
      vatRegistered: "on",
      pricesIncludeTax: "on",
      vatNumber: "399999999900003",
      defaultSalesTaxCodeId: codes.STD,
      defaultPurchaseTaxCodeId: codes.STD,
    });
  }

  const branchId = (
    await createBranch(ctx, { code: "RUH-BRG", name: "[DEMO] Olaya Burgers", type: "RESTAURANT" })
  ).id;
  const warehouseId = (
    await createWarehouse(ctx, {
      branchId,
      code: "BRG-KIT",
      name: "Olaya kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;

  // One kit product per dish, with opening stock at the demo cost.
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  const categories = new Map<string, string>();
  for (const name of ["Burgers", "Sides", "Drinks"])
    categories.set(name, (await createMenuCategory(ctx, { name })).id);
  const items = new Map<string, { id: string; price: number }>();
  for (const [code, name, nameAr, category, price, cost] of MENU) {
    const productId = (
      await createProduct(ctx, {
        sku: `DEMO-${code}`,
        nameEn: `[DEMO] ${name} kit`,
        nameAr: `[تجريبي] ${nameAr}`,
        type: "FINISHED_GOOD",
        baseUomId: each,
      })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId,
      productId,
      quantity: "300",
      uomId: each,
      unitCost: cost,
      note: "Demo data",
    });
    const id = (
      await createMenuItem(ctx, {
        code,
        name,
        nameAr,
        categoryId: categories.get(category),
        kind: "ITEM",
        productId,
      })
    ).id;
    for (const channel of ["DINE_IN", "TAKEAWAY"])
      await addMenuItemPrice(ctx, id, { channel, price, effectiveFrom: today });
    items.set(code, { id, price: Number(price) });
  }

  // The till with an open shift, a grill station, and the dining room.
  const registerId = (
    await createRegister(ctx, { branchId, warehouseId, code: "TILL1", name: "Front till" })
  ).id;
  const shift = await openShift(ctx, registerId, { openingFloat: "500" });
  await createStation(ctx, {
    branchId,
    code: "GRILL",
    name: "Grill",
    targetMinutes: "10",
    isDefault: "on",
  });
  const floorId = (await createFloor(ctx, { branchId, warehouseId, name: "Main hall" })).id;
  for (let i = 0; i < 8; i += 1)
    await createTable(ctx, floorId, {
      code: `T${i + 1}`,
      seats: i < 6 ? "4" : "6",
      gridX: String((i % 4) * 2),
      gridY: String(Math.floor(i / 4) * 2),
    });

  // Today's sales so far: real orders through the till (stock used, VAT computed).
  const baskets: Array<[Array<[string, number]>, "CASH" | "CARD"]> = [
    [
      [
        ["BRG-CLS", 2],
        ["SD-FRY", 2],
        ["DR-COLA", 2],
      ],
      "CARD",
    ],
    [
      [
        ["BRG-CHS", 1],
        ["SD-RNG", 1],
        ["DR-WTR", 1],
      ],
      "CASH",
    ],
    [
      [
        ["BRG-CHK", 3],
        ["SD-FRY", 3],
        ["DR-COLA", 3],
      ],
      "CARD",
    ],
    [
      [
        ["BRG-CLS", 1],
        ["DR-WTR", 1],
      ],
      "CASH",
    ],
    [
      [
        ["BRG-CHS", 2],
        ["SD-FRY", 1],
        ["SD-RNG", 1],
        ["DR-COLA", 2],
      ],
      "CARD",
    ],
    [
      [
        ["BRG-CLS", 4],
        ["SD-FRY", 4],
        ["DR-COLA", 4],
      ],
      "CARD",
    ],
    [
      [
        ["BRG-CHK", 1],
        ["SD-FRY", 1],
      ],
      "CASH",
    ],
    [
      [
        ["BRG-CHS", 1],
        ["DR-COLA", 1],
      ],
      "CARD",
    ],
  ];
  for (const [lines, method] of baskets) {
    const total = lines.reduce((a, [code, qty]) => a + items.get(code)!.price * qty, 0);
    await submitOrder(ctx, {
      orderId: randomUUID(),
      registerId,
      shiftId: shift.id,
      channel: "TAKEAWAY",
      lines: lines.map(([code, qty]) => ({ itemId: items.get(code)!.id, quantity: String(qty) })),
      payments: [
        method === "CASH"
          ? { method, amount: String(total), tendered: String(Math.ceil(total / 50) * 50) }
          : { method, amount: String(total), cardScheme: "MADA" },
      ],
    });
  }

  // After the sample orders (their totals are list prices): drinks 20 % off, and loyalty points.
  await createPromotion(ctx, {
    name: "[DEMO] Drinks 20 % off",
    percent: "20",
    categoryIds: [categories.get("Drinks")],
    validFrom: today,
  });
  await saveLoyaltySettings(ctx, {
    enabled: "on",
    earnRate: "1",
    pointValue: "0.05",
    minRedeemPoints: "100",
  });

  // A pick-up ordering page, paid at the counter.
  await createOrderingChannel(ctx, {
    kind: "WEB",
    name: "[DEMO] Order online — Olaya",
    branchId,
    channels: ["TAKEAWAY"],
    paymentMode: "COUNTER",
  });
  console.log("  [DEMO] burger restaurant: branch RUH-BRG, till TILL1 (shift open), 8 tables");
}

/**
 * [DEMO] staff for the burger restaurant (HR1, ADR-079): two departments, a
 * reporting line and food-handler health certificates, one expiring soon so
 * the HR overview has something to flag. Idempotent by department code.
 */
export async function seedRestaurantStaff(ctx: TenantContext) {
  const db = getDb();
  if (
    await db.department.findFirst({
      where: { organizationId: ctx.organizationId, code: "KITCHEN" },
    })
  ) {
    console.log("  [DEMO] restaurant staff: present");
    return;
  }
  const branch = await db.branch.findFirst({
    where: { organizationId: ctx.organizationId, code: "RUH-BRG" },
  });
  if (!branch) return;
  const kitchen = (
    await createDepartment(ctx, { code: "KITCHEN", name: "Kitchen", nameAr: "المطبخ" })
  ).id;
  const front = (
    await createDepartment(ctx, { code: "FOH", name: "Front of house", nameAr: "الصالة" })
  ).id;
  const today = businessDate(TZ);
  const hire = (daysAgo: number) => addDays(today, -daysAgo);
  const person = async (
    firstName: string,
    lastName: string,
    jobTitle: string,
    departmentId: string,
    managerId: string | null,
    hiredDaysAgo: number,
    certificateExpiresInDays: number | null,
  ) => {
    const e = await createEmployee(ctx, {
      firstName,
      lastName,
      jobTitle,
      branchId: branch.id,
      departmentId,
      managerId: managerId ?? "",
      employmentType: "FULL_TIME",
      hireDate: hire(hiredDaysAgo),
      nationality: "SA",
    });
    if (certificateExpiresInDays !== null)
      await addEmployeeDocument(ctx, e.id, {
        type: "HEALTH_CERTIFICATE",
        expiresOn: addDays(today, certificateExpiresInDays),
      });
    return e.id;
  };
  const manager = await person(
    "[DEMO] Faisal",
    "Al-Harbi",
    "Restaurant manager",
    front,
    null,
    400,
    null,
  );
  const chef = await person("[DEMO] Noura", "Al-Qahtani", "Head chef", kitchen, manager, 300, 200);
  await person("[DEMO] Khalid", "Saeed", "Line cook", kitchen, chef, 120, 12);
  await person("[DEMO] Reem", "Al-Otaibi", "Line cook", kitchen, chef, 20, 340);
  await person("[DEMO] Majed", "Al-Dosari", "Cashier", front, manager, 60, 150);
  console.log("  [DEMO] restaurant staff: 2 departments, 5 employees");
}
