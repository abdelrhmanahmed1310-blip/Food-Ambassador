import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { hasPermission } from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden, notFound } from "@/server/errors";
import type { ApiContext } from "./clients";
import { pageLimit } from "./scopes";

/**
 * REST API v1 resources (DECISIONS.md ADR-090). Read-only, paginated by a
 * cursor (`after` = the last id of the previous page; ids are time-ordered
 * UUIDv7), amounts as decimal strings, dates as ISO 8601. These shapes are
 * the public contract described in openapi.ts: change them only with a new
 * version.
 */

const money = (v: { toString(): string } | null) => (v === null ? null : v.toString());
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export type Page<T> = { data: T[]; nextCursor: string | null };

function need(api: ApiContext, permission: Permission) {
  if (!hasPermission(api.ctx.grants, permission)) throw forbidden();
}

/** Cursor pagination over a time-ordered id. */
async function page<T extends { id: string }, R>(
  rows: (args: {
    take: number;
    cursor?: { id: string };
    skip?: number;
    orderBy: { id: "asc" };
  }) => Promise<T[]>,
  query: URLSearchParams,
  map: (row: T) => R,
): Promise<Page<R>> {
  const limit = pageLimit(query.get("limit"));
  const after = query.get("after");
  const found = await rows({
    take: limit + 1,
    orderBy: { id: "asc" },
    ...(after && /^[0-9a-f-]{36}$/i.test(after) ? { cursor: { id: after }, skip: 1 } : {}),
  });
  const more = found.length > limit;
  const items = found.slice(0, limit);
  return { data: items.map(map), nextCursor: more ? items[items.length - 1].id : null };
}

/** The company limit of a key, as a branch filter. */
const branchOf = (api: ApiContext): Prisma.BranchWhereInput =>
  api.companyId ? { companyId: api.companyId } : {};
const companyOf = (api: ApiContext) => (api.companyId ? { companyId: api.companyId } : {});

export async function listCompanies(api: ApiContext, query: URLSearchParams) {
  need(api, "branches.view");
  const org = api.ctx.organizationId;
  return withTenantTx(org, (tx) =>
    page(
      (a) =>
        tx.company.findMany({
          where: { organizationId: org, ...(api.companyId ? { id: api.companyId } : {}) },
          ...a,
        }),
      query,
      (c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        legalName: c.legalName,
        country: c.country,
        currency: c.currency,
        vatRegistered: c.vatRegistered,
        vatNumber: c.vatNumber,
        isDefault: c.isDefault,
        archived: c.archivedAt !== null,
      }),
    ),
  );
}

export async function listBranches(api: ApiContext, query: URLSearchParams) {
  need(api, "branches.view");
  const org = api.ctx.organizationId;
  return withTenantTx(org, (tx) =>
    page(
      (a) => tx.branch.findMany({ where: { organizationId: org, ...branchOf(api) }, ...a }),
      query,
      (b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        type: b.type,
        companyId: b.companyId,
        brandId: b.brandId,
        timeZone: b.timeZone,
        archived: b.archivedAt !== null,
      }),
    ),
  );
}

export async function listWarehouses(api: ApiContext, query: URLSearchParams) {
  need(api, "warehouses.view");
  const org = api.ctx.organizationId;
  return withTenantTx(org, (tx) =>
    page(
      (a) => tx.warehouse.findMany({ where: { organizationId: org, branch: branchOf(api) }, ...a }),
      query,
      (w) => ({
        id: w.id,
        code: w.code,
        name: w.name,
        type: w.type,
        branchId: w.branchId,
        archived: w.archivedAt !== null,
      }),
    ),
  );
}

export async function listProducts(api: ApiContext, query: URLSearchParams) {
  need(api, "catalog.view");
  const org = api.ctx.organizationId;
  return withTenantTx(org, (tx) =>
    page(
      (a) =>
        tx.product.findMany({
          where: { organizationId: org },
          include: { baseUom: { select: { code: true } }, barcodes: { select: { barcode: true } } },
          ...a,
        }),
      query,
      (p) => ({
        id: p.id,
        sku: p.sku,
        name: p.nameEn,
        nameAr: p.nameAr,
        type: p.type,
        baseUnit: p.baseUom.code,
        categoryId: p.categoryId,
        barcodes: p.barcodes.map((b) => b.barcode),
        archived: p.archivedAt !== null,
      }),
    ),
  );
}

export async function listSuppliers(api: ApiContext, query: URLSearchParams) {
  need(api, "suppliers.view");
  const org = api.ctx.organizationId;
  return withTenantTx(org, (tx) =>
    page(
      (a) => tx.supplier.findMany({ where: { organizationId: org }, ...a }),
      query,
      (s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        nameAr: s.nameAr,
        vatNumber: s.taxId,
        currency: s.currency,
        paymentTermsDays: s.paymentTermsDays,
        /** PENDING_APPROVAL, APPROVED or BLOCKED (ADR-091). */
        status: s.status,
        archived: s.archivedAt !== null,
      }),
    ),
  );
}

/** Stock on hand per warehouse, product, lot and status (quantities in the product's base unit). */
export async function listStock(api: ApiContext, query: URLSearchParams) {
  need(api, "inventory.view");
  const org = api.ctx.organizationId;
  const warehouseId = query.get("warehouseId");
  return withTenantTx(org, (tx) =>
    page(
      (a) =>
        tx.stockBalance.findMany({
          where: {
            organizationId: org,
            onHandQuantity: { not: 0 },
            warehouse: { branch: branchOf(api) },
            ...(warehouseId && /^[0-9a-f-]{36}$/i.test(warehouseId) ? { warehouseId } : {}),
          },
          include: { lot: { select: { lotCode: true, expiresOn: true } } },
          ...a,
        }),
      query,
      (b) => ({
        id: b.id,
        warehouseId: b.warehouseId,
        locationId: b.locationId,
        productId: b.productId,
        lot: b.lot ? { code: b.lot.lotCode, expiresOn: day(b.lot.expiresOn) } : null,
        status: b.stockStatus,
        onHand: money(b.onHandQuantity),
        reserved: money(b.reservedQuantity),
      }),
    ),
  );
}

const poSelect = {
  id: true,
  number: true,
  status: true,
  supplierId: true,
  warehouseId: true,
  companyId: true,
  currency: true,
  expectedOn: true,
  totalAmount: true,
  totalAmountBase: true,
  submittedAt: true,
  approvedAt: true,
  createdAt: true,
  lines: {
    orderBy: { lineNo: "asc" },
    select: {
      lineNo: true,
      productId: true,
      quantity: true,
      uom: { select: { code: true } },
      unitPrice: true,
      lineTotal: true,
      receivedQuantityBase: true,
    },
  },
} satisfies Prisma.PurchaseOrderSelect;
type PoRow = Prisma.PurchaseOrderGetPayload<{ select: typeof poSelect }>;

const poOut = (o: PoRow) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  supplierId: o.supplierId,
  warehouseId: o.warehouseId,
  companyId: o.companyId,
  currency: o.currency,
  expectedOn: day(o.expectedOn),
  total: money(o.totalAmount),
  totalInCompanyCurrency: money(o.totalAmountBase),
  submittedAt: o.submittedAt?.toISOString() ?? null,
  approvedAt: o.approvedAt?.toISOString() ?? null,
  createdAt: o.createdAt.toISOString(),
  lines: o.lines.map((l) => ({
    lineNo: l.lineNo,
    productId: l.productId,
    quantity: money(l.quantity),
    unit: l.uom.code,
    unitPrice: money(l.unitPrice),
    total: money(l.lineTotal),
    receivedBaseQuantity: money(l.receivedQuantityBase),
  })),
});

export async function listPurchaseOrders(api: ApiContext, query: URLSearchParams) {
  need(api, "purchasing.view");
  const org = api.ctx.organizationId;
  const status = query.get("status");
  return withTenantTx(org, (tx) =>
    page(
      (a) =>
        tx.purchaseOrder.findMany({
          where: {
            organizationId: org,
            ...companyOf(api),
            ...(status ? { status: status as PoRow["status"] } : {}),
          },
          select: poSelect,
          ...a,
        }),
      query,
      poOut,
    ),
  );
}

export async function getPurchaseOrder(api: ApiContext, id: string) {
  need(api, "purchasing.view");
  const org = api.ctx.organizationId;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Purchase order");
  const o = await withTenantTx(org, (tx) =>
    tx.purchaseOrder.findFirst({
      where: { organizationId: org, id, ...companyOf(api) },
      select: poSelect,
    }),
  );
  if (!o) throw notFound("Purchase order");
  return poOut(o);
}

export async function listSupplierInvoices(api: ApiContext, query: URLSearchParams) {
  need(api, "invoices.view");
  const org = api.ctx.organizationId;
  return withTenantTx(org, (tx) =>
    page(
      (a) =>
        tx.supplierInvoice.findMany({ where: { organizationId: org, ...companyOf(api) }, ...a }),
      query,
      (i) => ({
        id: i.id,
        number: i.number,
        supplierInvoiceNo: i.supplierInvoiceNo,
        supplierId: i.supplierId,
        companyId: i.companyId,
        status: i.status,
        matchStatus: i.matchStatus,
        invoiceDate: day(i.invoiceDate),
        dueDate: day(i.dueDate),
        currency: i.currency,
        net: money(i.netAmount),
        vat: money(i.taxAmount),
        gross: money(i.grossAmount),
      }),
    ),
  );
}

export async function listSalesInvoices(api: ApiContext, query: URLSearchParams) {
  need(api, "b2b.view");
  const org = api.ctx.organizationId;
  return withTenantTx(org, (tx) =>
    page(
      (a) => tx.salesInvoice.findMany({ where: { organizationId: org, ...companyOf(api) }, ...a }),
      query,
      (i) => ({
        id: i.id,
        number: i.number,
        customerId: i.customerId,
        companyId: i.companyId,
        status: i.status,
        invoiceDate: day(i.invoiceDate),
        dueDate: day(i.dueDate),
        currency: i.currency,
        net: money(i.netAmount),
        vat: money(i.taxAmount),
        gross: money(i.grossAmount),
      }),
    ),
  );
}

/** Point-of-sale orders, optionally by business date (from/to, inclusive). */
export async function listPosOrders(api: ApiContext, query: URLSearchParams) {
  need(api, "pos.view");
  const org = api.ctx.organizationId;
  const date = (v: string | null) =>
    v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : undefined;
  const from = date(query.get("from"));
  const to = date(query.get("to"));
  return withTenantTx(org, (tx) =>
    page(
      (a) =>
        tx.posOrder.findMany({
          where: {
            organizationId: org,
            ...companyOf(api),
            ...(from || to
              ? { businessDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
              : {}),
          },
          include: {
            lines: {
              orderBy: { lineNo: "asc" },
              select: {
                lineNo: true,
                menuItemId: true,
                name: true,
                quantity: true,
                netAmount: true,
                taxAmount: true,
                grossAmount: true,
              },
            },
          },
          ...a,
        }),
      query,
      (o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        branchId: o.branchId,
        companyId: o.companyId,
        channel: o.channel,
        businessDate: day(o.businessDate),
        orderedAt: o.orderedAt.toISOString(),
        net: money(o.netAmount),
        vat: money(o.taxAmount),
        gross: money(o.grossAmount),
        lines: o.lines.map((l) => ({
          lineNo: l.lineNo,
          menuItemId: l.menuItemId,
          name: l.name,
          quantity: money(l.quantity),
          net: money(l.netAmount),
          vat: money(l.taxAmount),
          gross: money(l.grossAmount),
        })),
      }),
    ),
  );
}
