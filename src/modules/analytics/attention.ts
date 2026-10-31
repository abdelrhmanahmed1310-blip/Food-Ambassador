import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import { EXPIRY_WARNING_DAYS } from "@/modules/inventory/queries";
import { addDays, businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";

/**
 * What needs someone's attention now (DECISIONS.md ADR-043), computed when
 * asked from the current data — nothing is stored or sent. Each item
 * appears only for users who may act on it, at the sites where they may,
 * and approvals never include the user's own submissions.
 */

export type AttentionKey =
  | "EXPIRED_STOCK"
  | "EXPIRING_STOCK"
  | "QUARANTINE"
  | "BELOW_MINIMUM"
  | "ORDERS_TO_APPROVE"
  | "REQUISITIONS_WAITING"
  | "COUNTS_TO_POST"
  | "INVOICE_EXCEPTIONS"
  | "INVOICES_OVERDUE"
  | "LABELS_TO_REVIEW"
  | "STATEMENTS_TO_VERIFY"
  | "NC_OPEN"
  | "ACTIONS_OVERDUE"
  | "RECALLS_ACTIVE"
  | "CUSTOMER_INVOICES_OVERDUE";

export interface AttentionItem {
  key: AttentionKey;
  tone: "danger" | "warning" | "info";
  count: number;
  /** Money involved, where it means something (overdue invoices). */
  amount?: Decimal;
  /** Path below /o/<slug>. */
  href: string;
  /** Up to five records to open directly. */
  links?: Array<{ label: string; href: string }>;
}

/** Warehouses filter for a scoped permission; null when the user does not hold it at all. */
function warehouseWhere(
  ctx: TenantContext,
  permission: Permission,
): Prisma.WarehouseWhereInput | null {
  if (!holdsAnyGrant(ctx.grants, permission)) return null;
  const s = accessibleScope(ctx.grants, permission);
  return s.all ? {} : { OR: [{ branchId: { in: s.branchIds } }, { id: { in: s.warehouseIds } }] };
}

function branchWhere(ctx: TenantContext, permission: Permission): Prisma.BranchWhereInput | null {
  if (!holdsAnyGrant(ctx.grants, permission)) return null;
  const s = accessibleScope(ctx.grants, permission);
  return s.all ? {} : { id: { in: s.branchIds } };
}

async function visibleWarehouseIds(tx: Tx, ctx: TenantContext, where: Prisma.WarehouseWhereInput) {
  return (
    await tx.warehouse.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null, ...where },
      select: { id: true },
    })
  ).map((w) => w.id);
}

export async function attentionItems(ctx: TenantContext): Promise<AttentionItem[]> {
  const today = businessDate(ctx.timeZone);
  const todayDate = new Date(`${today}T00:00:00Z`);
  const soonDate = new Date(`${addDays(today, EXPIRY_WARNING_DAYS)}T00:00:00Z`);
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    const items: AttentionItem[] = [];
    const push = (item: AttentionItem) => {
      if (item.count > 0) items.push(item);
    };

    const stock = warehouseWhere(ctx, "inventory.view");
    if (stock) {
      const base = {
        organizationId: org,
        onHandQuantity: { gt: 0 },
        stockStatus: "AVAILABLE" as const,
        warehouse: stock,
      };
      push({
        key: "EXPIRED_STOCK",
        tone: "danger",
        count: await tx.stockBalance.count({
          where: { ...base, lot: { expiresOn: { lt: todayDate } } },
        }),
        href: "/inventory",
      });
      push({
        key: "EXPIRING_STOCK",
        tone: "warning",
        count: await tx.stockBalance.count({
          where: { ...base, lot: { expiresOn: { gte: todayDate, lte: soonDate } } },
        }),
        href: "/inventory",
      });
    }

    const release = warehouseWhere(ctx, "inventory.quarantine.release");
    if (release)
      push({
        key: "QUARANTINE",
        tone: "warning",
        count: await tx.stockBalance.count({
          where: {
            organizationId: org,
            onHandQuantity: { gt: 0 },
            stockStatus: "QUARANTINE",
            warehouse: release,
          },
        }),
        href: "/inventory/stock?status=QUARANTINE",
      });

    const purchasing = warehouseWhere(ctx, "purchasing.view");
    if (purchasing) {
      const ids = await visibleWarehouseIds(tx, ctx, purchasing);
      if (ids.length > 0) {
        // Usable stock (available, not expired, not on recall hold) below the rule's minimum.
        const below = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count FROM (
            SELECT r.id
            FROM reorder_rules r
            LEFT JOIN stock_balances b
              ON b.organization_id = r.organization_id AND b.warehouse_id = r.warehouse_id
             AND b.product_id = r.product_id AND b.stock_status = 'AVAILABLE'
            LEFT JOIN inventory_lots l ON l.id = b.lot_id
            WHERE r.organization_id = ${org}::uuid AND r.warehouse_id = ANY(${ids}::uuid[])
            GROUP BY r.id, r.min_quantity_base
            HAVING COALESCE(SUM(b.on_hand_quantity - b.reserved_quantity) FILTER (
                     WHERE l.id IS NULL OR (NOT l.recall_hold AND (l.expires_on IS NULL OR l.expires_on >= ${today}::date))
                   ), 0) < r.min_quantity_base
          ) x`;
        push({
          key: "BELOW_MINIMUM",
          tone: "warning",
          count: Number(below[0]?.count ?? 0),
          href: "/purchasing/reorder",
        });
      }
    }

    // Orders whose next step this user may sign (ADR-049): branch steps need
    // a grant on the order's own branch or warehouse, head office an
    // organization-wide one; never their own orders or a second signature.
    if (holdsAnyGrant(ctx.grants, "purchasing.approve")) {
      const approveGrants = ctx.grants.filter((g) => g.permission === "purchasing.approve");
      const headOffice = approveGrants.some((g) => g.scope.type === "ORGANIZATION");
      const branchIds = approveGrants.flatMap((g) =>
        g.scope.type === "BRANCH" ? [g.scope.branchId] : [],
      );
      const warehouseIds = approveGrants.flatMap((g) =>
        g.scope.type === "WAREHOUSE" ? [g.scope.warehouseId] : [],
      );
      const local: Prisma.WarehouseWhereInput = {
        OR: [{ branchId: { in: branchIds } }, { id: { in: warehouseIds } }],
      };
      const levels: Prisma.PurchaseOrderWhereInput[] = [
        { pendingApprovalLevel: { in: ["BRANCH", "ANY"] }, warehouse: local },
      ];
      if (headOffice) levels.push({ pendingApprovalLevel: { in: ["HEAD_OFFICE", "ANY"] } });
      const candidates = await tx.purchaseOrder.findMany({
        where: {
          organizationId: org,
          status: "PENDING_APPROVAL",
          OR: levels,
          NOT: [{ submittedByUserId: ctx.userId }, { createdByUserId: ctx.userId }],
        },
        select: {
          approvalRound: true,
          approvals: { select: { round: true, approvedByUserId: true } },
        },
      });
      push({
        key: "ORDERS_TO_APPROVE",
        tone: "info",
        count: candidates.filter(
          (o) =>
            !o.approvals.some(
              (a) => a.round === o.approvalRound && a.approvedByUserId === ctx.userId,
            ),
        ).length,
        href: "/purchasing/orders?status=PENDING_APPROVAL",
      });
    }

    const manage = warehouseWhere(ctx, "purchasing.manage");
    if (manage)
      push({
        key: "REQUISITIONS_WAITING",
        tone: "info",
        count: await tx.purchaseRequisition.count({
          where: {
            organizationId: org,
            status: { in: ["SUBMITTED", "PARTIALLY_ORDERED"] },
            warehouse: manage,
          },
        }),
        href: "/purchasing/requisitions",
      });

    const counts = warehouseWhere(ctx, "inventory.count.approve");
    if (counts)
      push({
        key: "COUNTS_TO_POST",
        tone: "info",
        count: await tx.stockCount.count({
          where: { organizationId: org, status: "SUBMITTED", warehouse: counts },
        }),
        href: "/inventory/counts",
      });

    if (hasPermission(ctx.grants, "invoices.manage"))
      push({
        key: "INVOICE_EXCEPTIONS",
        tone: "info",
        count: await tx.supplierInvoice.count({
          where: {
            organizationId: org,
            status: "DRAFT",
            matchStatus: "EXCEPTION",
            exceptionApprovedAt: null,
            NOT: { createdByUserId: ctx.userId },
          },
        }),
        href: "/purchasing/invoices?status=DRAFT",
      });

    if (hasPermission(ctx.grants, "invoices.view")) {
      const due = await tx.supplierInvoice.findMany({
        where: { organizationId: org, status: "POSTED", dueDate: { lt: todayDate } },
        select: { id: true, grossAmount: true },
      });
      const settled = new Map(
        (
          await tx.settlementAllocation.groupBy({
            by: ["invoiceId"],
            where: {
              organizationId: org,
              invoiceId: { in: due.map((d) => d.id) },
              settlement: { status: "POSTED" },
            },
            _sum: { amount: true },
          })
        ).map((r) => [r.invoiceId, new Decimal(r._sum.amount?.toString() ?? "0")]),
      );
      let count = 0;
      let amount = new Decimal(0);
      for (const d of due) {
        const open = new Decimal(d.grossAmount.toString()).minus(settled.get(d.id) ?? 0);
        if (open.gt(0)) {
          count += 1;
          amount = amount.plus(open);
        }
      }
      push({
        key: "INVOICES_OVERDUE",
        tone: "warning",
        count,
        amount,
        href: "/purchasing/payables",
      });
    }

    if (hasPermission(ctx.grants, "labels.approve")) {
      const labels = await tx.recipeLabel.findMany({
        where: {
          organizationId: org,
          status: "PENDING_REVIEW",
          NOT: { createdByUserId: ctx.userId },
        },
        select: { id: true, labelNo: true, recipe: { select: { code: true } } },
        orderBy: { createdAt: "asc" },
        take: 50,
      });
      push({
        key: "LABELS_TO_REVIEW",
        tone: "info",
        count: labels.length,
        href: labels.length > 0 ? `/recipes/labels/${labels[0].id}` : "/recipes/allergens",
        links: labels.slice(0, 5).map((l) => ({
          label: `${l.recipe.code} #${l.labelNo}`,
          href: `/recipes/labels/${l.id}`,
        })),
      });
    }

    if (hasPermission(ctx.grants, "nutrition.manage")) {
      const [profiles, declarations] = await Promise.all([
        tx.nutritionProfile.findMany({
          where: {
            organizationId: org,
            supersededAt: null,
            verifiedAt: null,
            NOT: { createdByUserId: ctx.userId },
          },
          select: { productId: true },
          take: 200,
        }),
        tx.allergenDeclaration.findMany({
          where: {
            organizationId: org,
            supersededAt: null,
            verifiedAt: null,
            status: { not: "UNKNOWN" },
            NOT: { declaredByUserId: ctx.userId },
          },
          select: { productId: true },
          distinct: ["productId"],
          take: 200,
        }),
      ]);
      const productIds = [...new Set([...profiles, ...declarations].map((p) => p.productId))];
      const products = await tx.product.findMany({
        where: { organizationId: org, id: { in: productIds.slice(0, 5) } },
        select: { id: true, sku: true },
        orderBy: { sku: "asc" },
      });
      push({
        key: "STATEMENTS_TO_VERIFY",
        tone: "info",
        count: productIds.length,
        href: products[0] ? `/catalog/products/${products[0].id}/nutrition` : "/catalog/products",
        links: products.map((p) => ({ label: p.sku, href: `/catalog/products/${p.id}/nutrition` })),
      });
    }

    const safety = branchWhere(ctx, "foodsafety.manage");
    if (safety) {
      push({
        key: "NC_OPEN",
        tone: "warning",
        count: await tx.nonConformance.count({
          where: { organizationId: org, status: { not: "CLOSED" }, branch: safety },
        }),
        href: "/food-safety/non-conformances",
      });
      push({
        key: "ACTIONS_OVERDUE",
        tone: "danger",
        count: await tx.correctiveAction.count({
          where: {
            organizationId: org,
            status: "OPEN",
            dueOn: { lt: todayDate },
            nonConformance: { branch: safety },
          },
        }),
        href: "/food-safety/non-conformances",
      });
    }

    if (hasPermission(ctx.grants, "b2b.view")) {
      const due = await tx.salesInvoice.findMany({
        where: { organizationId: org, status: "POSTED", dueDate: { lt: todayDate } },
        select: { id: true, grossAmount: true },
      });
      const got = new Map(
        (
          await tx.customerReceiptAllocation.groupBy({
            by: ["invoiceId"],
            where: {
              organizationId: org,
              invoiceId: { in: due.map((d) => d.id) },
              receipt: { status: "POSTED" },
            },
            _sum: { amount: true },
          })
        ).map((r) => [r.invoiceId, new Decimal(r._sum.amount?.toString() ?? "0")]),
      );
      let count = 0;
      let amount = new Decimal(0);
      for (const d of due) {
        const open = new Decimal(d.grossAmount.toString()).minus(got.get(d.id) ?? 0);
        if (open.gt(0)) {
          count += 1;
          amount = amount.plus(open);
        }
      }
      push({
        key: "CUSTOMER_INVOICES_OVERDUE",
        tone: "warning",
        count,
        amount,
        href: "/b2b/balances",
      });
    }

    if (hasPermission(ctx.grants, "recalls.manage"))
      push({
        key: "RECALLS_ACTIVE",
        tone: "danger",
        count: await tx.recall.count({ where: { organizationId: org, status: "ACTIVE" } }),
        href: "/recalls",
      });

    const order = { danger: 0, warning: 1, info: 2 };
    return items.sort((a, b) => order[a.tone] - order[b.tone]);
  });
}
