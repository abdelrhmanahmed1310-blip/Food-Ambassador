import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { accessibleScope, holdsAnyGrant, hasPermission } from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { normalizeQuery } from "./rules";

/**
 * Global search (DECISIONS.md ADR-088): one box finds master data and
 * documents by code, number or name (Arabic names too). Each group is
 * searched only when the user may open it, and only at the branches and
 * warehouses where they may — the same permissions as the pages it links
 * to. Nothing is indexed outside the database; trigram indexes keep
 * "contains" searches fast.
 */

export const SEARCH_GROUPS = [
  "products",
  "suppliers",
  "customers",
  "guests",
  "employees",
  "recipes",
  "menuItems",
  "lots",
  "purchaseOrders",
  "receipts",
  "supplierInvoices",
  "salesOrders",
  "salesInvoices",
  "posOrders",
  "inventoryDocuments",
] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export interface SearchHit {
  id: string;
  /** Code or number. */
  code: string;
  title: string;
  /** Arabic name, when there is one. */
  titleAr?: string | null;
  /** Path below /o/<slug>. */
  href: string;
}

const PER_GROUP = 6;
const like = (q: string) => ({ contains: q, mode: "insensitive" as const });

/** Warehouses the user may see for a scoped permission; null when not held at all. */
function warehouses(ctx: TenantContext, permission: Permission): Prisma.WarehouseWhereInput | null {
  if (!holdsAnyGrant(ctx.grants, permission)) return null;
  const s = accessibleScope(ctx.grants, permission);
  return s.all ? {} : { OR: [{ branchId: { in: s.branchIds } }, { id: { in: s.warehouseIds } }] };
}

export async function globalSearch(ctx: TenantContext, raw: unknown) {
  const query = normalizeQuery(raw);
  if (!query)
    return { query: null, groups: [] as Array<{ group: SearchGroup; hits: SearchHit[] }> };
  const { text: q, digits } = query;
  const org = ctx.organizationId;
  const can = (p: Permission) => hasPermission(ctx.grants, p);
  return withTenantTx(org, async (tx) => {
    const groups: Array<{ group: SearchGroup; hits: SearchHit[] }> = [];
    const add = (group: SearchGroup, hits: SearchHit[]) => {
      if (hits.length > 0) groups.push({ group, hits });
    };

    if (can("catalog.view"))
      add(
        "products",
        (
          await tx.product.findMany({
            where: {
              organizationId: org,
              OR: [
                { sku: like(q) },
                { nameEn: like(q) },
                { nameAr: like(q) },
                { barcodes: { some: { barcode: like(q) } } },
              ],
            },
            select: { id: true, sku: true, nameEn: true, nameAr: true },
            orderBy: { sku: "asc" },
            take: PER_GROUP,
          })
        ).map((p) => ({
          id: p.id,
          code: p.sku,
          title: p.nameEn,
          titleAr: p.nameAr,
          href: `/catalog/products/${p.id}`,
        })),
      );

    if (can("suppliers.view"))
      add(
        "suppliers",
        (
          await tx.supplier.findMany({
            where: {
              organizationId: org,
              OR: [{ code: like(q) }, { name: like(q) }, { nameAr: like(q) }, { taxId: like(q) }],
            },
            select: { id: true, code: true, name: true, nameAr: true },
            orderBy: { code: "asc" },
            take: PER_GROUP,
          })
        ).map((s) => ({
          id: s.id,
          code: s.code,
          title: s.name,
          titleAr: s.nameAr,
          href: `/suppliers/${s.id}`,
        })),
      );

    if (can("b2b.view"))
      add(
        "customers",
        (
          await tx.customer.findMany({
            where: {
              organizationId: org,
              OR: [{ code: like(q) }, { name: like(q) }, { nameAr: like(q) }, { taxId: like(q) }],
            },
            select: { id: true, code: true, name: true, nameAr: true },
            orderBy: { code: "asc" },
            take: PER_GROUP,
          })
        ).map((c) => ({
          id: c.id,
          code: c.code,
          title: c.name,
          titleAr: c.nameAr,
          href: `/b2b/customers/${c.id}`,
        })),
      );

    if (can("customers.view"))
      add(
        "guests",
        (
          await tx.posCustomer.findMany({
            where: {
              organizationId: org,
              erasedAt: null,
              // Phones are stored as +9665…; a local number (05…) matches without its leading 0.
              OR: [
                { name: like(q) },
                ...(digits
                  ? [
                      { phone: { contains: digits } },
                      { phone: { contains: digits.replace(/^0+/, "") } },
                    ]
                  : []),
              ],
            },
            select: { id: true, name: true, phone: true },
            orderBy: { name: "asc" },
            take: PER_GROUP,
          })
        ).map((c) => ({
          id: c.id,
          code: c.phone ?? "",
          title: c.name,
          href: `/pos/customers/${c.id}`,
        })),
      );

    if (holdsAnyGrant(ctx.grants, "hr.view") || holdsAnyGrant(ctx.grants, "hr.manage")) {
      const view = accessibleScope(ctx.grants, "hr.view");
      const manage = accessibleScope(ctx.grants, "hr.manage");
      const branches =
        view.all || manage.all
          ? {}
          : { branchId: { in: [...view.branchIds, ...manage.branchIds] } };
      add(
        "employees",
        (
          await tx.employee.findMany({
            where: {
              organizationId: org,
              ...branches,
              OR: [
                { number: like(q) },
                { firstName: like(q) },
                { lastName: like(q) },
                { nameAr: like(q) },
                { jobTitle: like(q) },
              ],
            },
            select: { id: true, number: true, firstName: true, lastName: true, nameAr: true },
            orderBy: { number: "asc" },
            take: PER_GROUP,
          })
        ).map((e) => ({
          id: e.id,
          code: e.number,
          title: `${e.firstName} ${e.lastName}`,
          titleAr: e.nameAr,
          href: `/hr/employees/${e.id}`,
        })),
      );
    }

    if (can("recipes.view"))
      add(
        "recipes",
        (
          await tx.recipe.findMany({
            where: {
              organizationId: org,
              OR: [{ code: like(q) }, { name: like(q) }, { nameAr: like(q) }],
            },
            select: { id: true, code: true, name: true, nameAr: true },
            orderBy: { code: "asc" },
            take: PER_GROUP,
          })
        ).map((r) => ({
          id: r.id,
          code: r.code,
          title: r.name,
          titleAr: r.nameAr,
          href: `/recipes/${r.id}`,
        })),
      );

    if (can("menu.view"))
      add(
        "menuItems",
        (
          await tx.menuItem.findMany({
            where: {
              organizationId: org,
              OR: [{ code: like(q) }, { name: like(q) }, { nameAr: like(q) }],
            },
            select: { id: true, code: true, name: true, nameAr: true },
            orderBy: { code: "asc" },
            take: PER_GROUP,
          })
        ).map((m) => ({
          id: m.id,
          code: m.code,
          title: m.name,
          titleAr: m.nameAr,
          href: `/menu/items/${m.id}`,
        })),
      );

    if (can("traceability.view"))
      add(
        "lots",
        (
          await tx.inventoryLot.findMany({
            where: { organizationId: org, lotCode: like(q) },
            select: { id: true, lotCode: true, product: { select: { sku: true, nameEn: true } } },
            orderBy: { firstReceivedAt: "desc" },
            take: PER_GROUP,
          })
        ).map((l) => ({
          id: l.id,
          code: l.lotCode,
          title: `${l.product.sku} — ${l.product.nameEn}`,
          href: `/traceability/lots/${l.id}`,
        })),
      );

    const purchasing = warehouses(ctx, "purchasing.view");
    if (purchasing) {
      add(
        "purchaseOrders",
        (
          await tx.purchaseOrder.findMany({
            where: { organizationId: org, number: like(q), warehouse: purchasing },
            select: { id: true, number: true, supplier: { select: { name: true } } },
            orderBy: { createdAt: "desc" },
            take: PER_GROUP,
          })
        ).map((o) => ({
          id: o.id,
          code: o.number,
          title: o.supplier.name,
          href: `/purchasing/orders/${o.id}`,
        })),
      );
      add(
        "receipts",
        (
          await tx.goodsReceipt.findMany({
            where: { organizationId: org, number: like(q), warehouse: purchasing },
            select: { id: true, number: true, supplier: { select: { name: true } } },
            orderBy: { receivedAt: "desc" },
            take: PER_GROUP,
          })
        ).map((r) => ({
          id: r.id,
          code: r.number,
          title: r.supplier.name,
          href: `/purchasing/receipts/${r.id}`,
        })),
      );
    }

    if (can("invoices.view"))
      add(
        "supplierInvoices",
        (
          await tx.supplierInvoice.findMany({
            where: {
              organizationId: org,
              OR: [{ number: like(q) }, { supplierInvoiceNo: like(q) }],
            },
            select: {
              id: true,
              number: true,
              supplierInvoiceNo: true,
              supplier: { select: { name: true } },
            },
            orderBy: { invoiceDate: "desc" },
            take: PER_GROUP,
          })
        ).map((i) => ({
          id: i.id,
          code: i.number,
          title: `${i.supplier.name} · ${i.supplierInvoiceNo}`,
          href: `/purchasing/invoices/${i.id}`,
        })),
      );

    if (can("b2b.view")) {
      add(
        "salesOrders",
        (
          await tx.salesOrder.findMany({
            where: { organizationId: org, number: like(q) },
            select: { id: true, number: true, customer: { select: { name: true } } },
            orderBy: { createdAt: "desc" },
            take: PER_GROUP,
          })
        ).map((o) => ({
          id: o.id,
          code: o.number,
          title: o.customer.name,
          href: `/b2b/orders/${o.id}`,
        })),
      );
      add(
        "salesInvoices",
        (
          await tx.salesInvoice.findMany({
            where: { organizationId: org, number: like(q) },
            select: { id: true, number: true, customer: { select: { name: true } } },
            orderBy: { invoiceDate: "desc" },
            take: PER_GROUP,
          })
        ).map((i) => ({
          id: i.id,
          code: i.number,
          title: i.customer.name,
          href: `/b2b/invoices/${i.id}`,
        })),
      );
    }

    if (holdsAnyGrant(ctx.grants, "pos.view")) {
      const s = accessibleScope(ctx.grants, "pos.view");
      const sites = s.all
        ? {}
        : { OR: [{ branchId: { in: s.branchIds } }, { warehouseId: { in: s.warehouseIds } }] };
      add(
        "posOrders",
        (
          await tx.posOrder.findMany({
            where: { organizationId: org, number: like(q), ...sites },
            select: { id: true, number: true, businessDate: true },
            orderBy: { orderedAt: "desc" },
            take: PER_GROUP,
          })
        ).map((o) => ({
          id: o.id,
          code: o.number,
          title: o.businessDate.toISOString().slice(0, 10),
          href: `/pos/orders/${o.id}`,
        })),
      );
    }

    const stock = warehouses(ctx, "inventory.view");
    if (stock)
      add(
        "inventoryDocuments",
        (
          await tx.inventoryDocument.findMany({
            where: { organizationId: org, number: like(q), warehouse: stock },
            select: { id: true, number: true, type: true, warehouse: { select: { code: true } } },
            orderBy: { postedAt: "desc" },
            take: PER_GROUP,
          })
        ).map((d) => ({
          id: d.id,
          code: d.number,
          title: d.warehouse.code,
          href: `/inventory/documents/${d.id}`,
        })),
      );

    return { query: q, groups };
  });
}
