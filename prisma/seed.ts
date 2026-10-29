/**
 * DEVELOPMENT SEED — demo data only. Creates two clearly labelled "[DEMO]"
 * organizations with users in different roles, for manual testing of
 * permissions and tenant isolation. Uses the real services, so seeded data
 * obeys the same rules (audit events, constraints) as user-created data.
 *
 * Run: pnpm db:seed     Refuses to run when NODE_ENV=production.
 */
import "dotenv/config";
import type { ProductInput } from "@/modules/catalog/schemas";
import { addConversion, createProduct, createUnit, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createOrganization } from "@/modules/organizations/service";
import { createBranch } from "@/modules/sites/branches";
import { createLocation, createWarehouse } from "@/modules/sites/warehouses";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { getAuth } from "@/server/auth/auth";
import { getDb } from "@/server/db/client";
import { withSystemTx } from "@/server/db/transactions";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD ?? "demo-password-123";

async function ensureUser(name: string, email: string): Promise<string> {
  const existing = await getDb().user.findUnique({ where: { email } });
  if (existing) return existing.id;
  const { user } = await getAuth().api.signUpEmail({ body: { name, email, password: PASSWORD } });
  return user.id;
}

async function ctxFor(userId: string, slug: string): Promise<TenantContext> {
  const ctx = await withSystemTx((tx) => resolveTenantContext(tx, userId, slug));
  if (!ctx) throw new Error(`No access for ${userId} in ${slug}`);
  return ctx;
}

async function grant(
  ctx: TenantContext,
  userId: string,
  roleKey: string,
  scope: { branchId?: string } = {},
) {
  const db = getDb();
  const role = await db.role.findUniqueOrThrow({
    where: { organizationId_key: { organizationId: ctx.organizationId, key: roleKey } },
  });
  const membership = await db.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: ctx.organizationId, userId } },
    create: { organizationId: ctx.organizationId, userId, invitedByUserId: ctx.userId },
    update: {},
  });
  await db.membershipRole.create({
    data: {
      organizationId: ctx.organizationId,
      membershipId: membership.id,
      roleId: role.id,
      scopeType: scope.branchId ? "BRANCH" : "ORGANIZATION",
      branchId: scope.branchId,
    },
  });
}

async function seedOrganization(spec: {
  name: string;
  currency: string;
  timeZone: string;
  owner: [string, string];
  branches: Array<{
    code: string;
    name: string;
    type: "RESTAURANT" | "CENTRAL_KITCHEN";
    warehouses: Array<{ code: string; name: string; type: "MAIN" | "KITCHEN_STORE" }>;
  }>;
  members: Array<{ name: string; email: string; role: string; branchCode?: string }>;
}) {
  const db = getDb();
  const existing = await db.organization.findFirst({ where: { name: spec.name } });
  if (existing) {
    // Organizations seeded before inventory existed get their demo stock now (idempotent).
    const owner = await db.user.findUniqueOrThrow({ where: { email: spec.owner[1] } });
    await seedStock(await ctxFor(owner.id, existing.slug), spec.timeZone);
    console.log(`  ${spec.name}: present; demo stock ensured`);
    return;
  }
  const ownerId = await ensureUser(...spec.owner);
  const org = await createOrganization(ownerId, {
    name: spec.name,
    baseCurrency: spec.currency,
    timeZone: spec.timeZone,
    defaultLocale: "en",
  });
  const ctx = await ctxFor(ownerId, org.slug);
  const branchIds = new Map<string, string>();
  for (const b of spec.branches) {
    const { id } = await createBranch(ctx, { code: b.code, name: b.name, type: b.type });
    branchIds.set(b.code, id);
    for (const w of b.warehouses) {
      const wh = await createWarehouse(ctx, {
        branchId: id,
        code: w.code,
        name: w.name,
        type: w.type,
      });
      await createLocation(ctx, wh.id, {
        code: "DRY-1",
        name: "Dry store",
        temperatureZone: "AMBIENT",
      });
      await createLocation(ctx, wh.id, {
        code: "CHILL-1",
        name: "Walk-in chiller",
        temperatureZone: "CHILLED",
      });
    }
  }
  for (const m of spec.members) {
    const userId = await ensureUser(m.name, m.email);
    await grant(ctx, userId, m.role, m.branchCode ? { branchId: branchIds.get(m.branchCode) } : {});
  }
  await seedStock(await ctxFor(ownerId, org.slug), spec.timeZone);
  console.log(`  ${spec.name}: /o/${org.slug}`);
}

/**
 * Demo catalog and opening stock, including one expired and one soon-expiring
 * lot. Every step is idempotent so a partially seeded database can be re-run.
 */
async function seedStock(ctx: TenantContext, timeZone: string) {
  const db = getDb();
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const tray =
    units.tray ??
    (await createUnit(ctx, { code: "tray", nameEn: "Tray", nameAr: "صينية", dimension: "COUNT" }))
      .id;
  const product = async (input: ProductInput) =>
    (await db.product.findFirst({ where: { organizationId: ctx.organizationId, sku: input.sku } }))
      ?.id ?? (await createProduct(ctx, input)).id;
  const rice = await product({
    sku: "DEMO-RICE",
    nameEn: "[DEMO] Basmati rice",
    nameAr: "[تجريبي] أرز بسمتي",
    type: "RAW_MATERIAL",
    baseUomId: units.kg,
  });
  const milk = await product({
    sku: "DEMO-MILK",
    nameEn: "[DEMO] Fresh milk",
    nameAr: "[تجريبي] حليب طازج",
    type: "RAW_MATERIAL",
    baseUomId: units.l,
    lotTracking: "LOT_AND_EXPIRY",
    shelfLifeDays: "7",
    storageRequirement: "CHILLED",
  });
  const eggs = await product({
    sku: "DEMO-EGGS",
    nameEn: "[DEMO] Eggs",
    nameAr: "[تجريبي] بيض",
    type: "RAW_MATERIAL",
    baseUomId: units.each,
    lotTracking: "LOT",
  });
  if (!(await db.productUomConversion.findFirst({ where: { productId: eggs, uomId: tray } }))) {
    await addConversion(ctx, eggs, { uomId: tray, factorToBase: "30" });
  }
  const warehouse = await db.warehouse.findFirstOrThrow({
    where: { organizationId: ctx.organizationId },
    orderBy: { code: "asc" },
  });
  const today = businessDate(timeZone);
  const opening = async (productId: string, input: Record<string, string>) => {
    if (
      await db.inventoryLedgerEntry.findFirst({
        where: {
          organizationId: ctx.organizationId,
          productId,
          warehouseId: warehouse.id,
          ...(input.lotCode ? { lot: { lotCode: input.lotCode } } : {}),
        },
      })
    )
      return;
    await postOpeningBalance(ctx, { warehouseId: warehouse.id, productId, ...input });
  };
  await opening(rice, { quantity: "250", uomId: units.kg, unitCost: "48", note: "Demo data" });
  await opening(milk, {
    lotCode: "DEMO-M-1",
    expiresOn: addDays(today, 3),
    quantity: "40",
    uomId: units.l,
    note: "Demo data",
  });
  await opening(milk, {
    lotCode: "DEMO-M-0",
    expiresOn: addDays(today, -1),
    quantity: "6",
    uomId: units.l,
    note: "Demo data (expired lot)",
  });
  await opening(eggs, { lotCode: "DEMO-E-1", quantity: "12", uomId: tray, note: "Demo data" });
}

async function main() {
  console.log("Seeding DEMO data (development only)…");
  await seedOrganization({
    name: "[DEMO] Nile Kitchens",
    currency: "EGP",
    timeZone: "Africa/Cairo",
    owner: ["Demo Owner (Nile)", "owner@nile.demo.test"],
    branches: [
      {
        code: "CAI-01",
        name: "Cairo Downtown",
        type: "RESTAURANT",
        warehouses: [{ code: "CAI-01-MAIN", name: "Downtown main store", type: "MAIN" }],
      },
      {
        code: "CAI-CK",
        name: "Cairo Central Kitchen",
        type: "CENTRAL_KITCHEN",
        warehouses: [{ code: "CK-MAIN", name: "Central kitchen store", type: "MAIN" }],
      },
    ],
    members: [
      {
        name: "Demo Branch Manager",
        email: "manager@nile.demo.test",
        role: "branch_manager",
        branchCode: "CAI-01",
      },
      { name: "Demo Analyst", email: "analyst@nile.demo.test", role: "analyst" },
    ],
  });
  await seedOrganization({
    name: "[DEMO] Gulf Catering",
    currency: "SAR",
    timeZone: "Asia/Riyadh",
    owner: ["Demo Owner (Gulf)", "owner@gulf.demo.test"],
    branches: [
      {
        code: "RUH-01",
        name: "Riyadh Kitchen",
        type: "CENTRAL_KITCHEN",
        warehouses: [{ code: "RUH-MAIN", name: "Riyadh main store", type: "MAIN" }],
      },
    ],
    members: [{ name: "Demo Admin (Gulf)", email: "admin@gulf.demo.test", role: "admin" }],
  });
  console.log(`Demo users share the password: ${PASSWORD} (override with SEED_PASSWORD).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => getDb().$disconnect());
