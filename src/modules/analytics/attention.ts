import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { approvalBlock, holdsApprovalLevel } from "@/modules/approvals/rules";
import type { Permission } from "@/modules/access/permissions";
import { EXPIRY_WARNING_DAYS } from "@/modules/inventory/queries";
import { fsDocumentReviewsDue, fsDocumentsUnread } from "@/modules/foodsafety/documents";
import { equipmentAttention } from "@/modules/foodsafety/equipment";
import { haccpReviewsDue } from "@/modules/foodsafety/haccp";
import { qualityAttention } from "@/modules/foodsafety/quality";
import { supplierDocumentsDue } from "@/modules/procurement/compliance";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { EXPIRY_WARNING_DAYS as TRADE_DOC_WARNING_DAYS } from "@/modules/trade/document-rules";
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
  | "CUSTOMER_INVOICES_OVERDUE"
  | "POS_SHORTFALLS"
  | "SUPPLIERS_TO_APPROVE"
  | "SUPPLIER_BANK_ACCOUNTS_TO_VERIFY"
  | "SUPPLIER_DOCUMENTS_EXPIRED"
  | "SUPPLIER_DOCUMENTS_EXPIRING"
  | "SUPPLIER_RETURNS_AWAITING_CREDIT"
  | "HACCP_REVIEWS_DUE"
  | "FS_DOCUMENT_REVIEWS_DUE"
  | "FS_DOCUMENTS_UNREAD"
  | "COMPLAINTS_OPEN"
  | "AUDITS_OVERDUE"
  | "EQUIPMENT_OVERDUE"
  | "EQUIPMENT_DUE_SOON"
  | "EQUIPMENT_OUT_OF_SERVICE"
  | "INSPECTIONS_WAITING"
  | "IMPORT_SHIPMENTS_LATE"
  | "TRADE_DOCUMENTS_EXPIRED"
  | "TRADE_DOCUMENTS_EXPIRING"
  | "COLD_CHAIN_EXCURSIONS";

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

    // Documents whose next step this user may sign (ADR-049): the same rule
    // as the document pages — level for the site, never the author, never a
    // second signature in the same round.
    const signable = (
      permission: "purchasing.approve" | "inventory.count.approve",
      d: {
        createdByUserId: string;
        submittedByUserId: string | null;
        pendingApprovalLevel: "BRANCH" | "HEAD_OFFICE" | "ANY" | null;
        approvalRound: number;
        warehouseId: string;
        warehouse: { branchId: string };
        approvals: Array<{ round: number; approvedByUserId: string }>;
      },
    ) =>
      approvalBlock({
        userId: ctx.userId,
        authors: [d.createdByUserId, d.submittedByUserId],
        signedThisRound: d.approvals
          .filter((a) => a.round === d.approvalRound)
          .map((a) => a.approvedByUserId),
        holdsLevel: holdsApprovalLevel(ctx.grants, permission, d.pendingApprovalLevel ?? "ANY", {
          branchId: d.warehouse.branchId,
          warehouseId: d.warehouseId,
        }),
      }) === null;
    const chainFields = {
      createdByUserId: true,
      submittedByUserId: true,
      pendingApprovalLevel: true,
      approvalRound: true,
      warehouseId: true,
      warehouse: { select: { branchId: true } },
      approvals: { select: { round: true, approvedByUserId: true } },
    } as const;

    const approve = warehouseWhere(ctx, "purchasing.approve");
    if (approve) {
      const orders = await tx.purchaseOrder.findMany({
        where: { organizationId: org, status: "PENDING_APPROVAL", warehouse: approve },
        select: chainFields,
      });
      push({
        key: "ORDERS_TO_APPROVE",
        tone: "info",
        count: orders.filter((o) => signable("purchasing.approve", o)).length,
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
    if (counts) {
      const submitted = await tx.stockCount.findMany({
        where: { organizationId: org, status: "SUBMITTED", warehouse: counts },
        select: { ...chainFields, approvalChain: true },
      });
      push({
        key: "COUNTS_TO_POST",
        tone: "info",
        // Without a chain any approver of the warehouse may post (as before).
        count: submitted.filter(
          (c) => c.approvalChain.length === 0 || signable("inventory.count.approve", c),
        ).length,
        href: "/inventory/counts",
      });
    }

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

    const adjust = warehouseWhere(ctx, "inventory.adjust");
    if (adjust) {
      const ids = await visibleWarehouseIds(tx, ctx, adjust);
      push({
        key: "POS_SHORTFALLS",
        tone: "warning",
        count: await tx.posConsumptionShortfall.count({
          where: { organizationId: org, status: "OPEN", warehouseId: { in: ids } },
        }),
        href: "/pos/shortfalls",
      });
    }

    if (hasPermission(ctx.grants, "recalls.manage"))
      push({
        key: "RECALLS_ACTIVE",
        tone: "danger",
        count: await tx.recall.count({ where: { organizationId: org, status: "ACTIVE" } }),
        href: "/recalls",
      });

    // Supplier compliance (ADR-091): never the user's own additions to approve.
    if (hasPermission(ctx.grants, "suppliers.approve")) {
      push({
        key: "SUPPLIERS_TO_APPROVE",
        tone: "info",
        count: await tx.supplier.count({
          where: {
            organizationId: org,
            status: "PENDING_APPROVAL",
            archivedAt: null,
            NOT: { createdByUserId: ctx.userId },
          },
        }),
        href: "/suppliers?approval=PENDING_APPROVAL",
      });
      const accounts = await tx.supplierBankAccount.findMany({
        where: {
          organizationId: org,
          verifiedAt: null,
          archivedAt: null,
          NOT: { createdByUserId: ctx.userId },
        },
        select: { supplier: { select: { id: true, code: true } } },
        take: 50,
      });
      push({
        key: "SUPPLIER_BANK_ACCOUNTS_TO_VERIFY",
        tone: "warning",
        count: accounts.length,
        href: `/suppliers/${accounts[0]?.supplier.id ?? ""}`,
        links: accounts
          .slice(0, 5)
          .map((a) => ({ label: a.supplier.code, href: `/suppliers/${a.supplier.id}` })),
      });
    }
    if (hasPermission(ctx.grants, "suppliers.manage")) {
      const due = await supplierDocumentsDue(tx, ctx);
      const links = (rows: typeof due.expired) =>
        [...new Map(rows.map((r) => [r.supplier.id, r.supplier])).values()]
          .slice(0, 5)
          .map((s) => ({ label: s.code, href: `/suppliers/${s.id}` }));
      push({
        key: "SUPPLIER_DOCUMENTS_EXPIRED",
        tone: "danger",
        count: due.expired.length,
        href: "/suppliers?documents=expired",
        links: links(due.expired),
      });
      push({
        key: "SUPPLIER_DOCUMENTS_EXPIRING",
        tone: "warning",
        count: due.expiring.length,
        href: "/suppliers?documents=expiring",
        links: links(due.expiring),
      });
    }

    // Approved HACCP plans whose review date has come (ADR-096).
    if (holdsAnyGrant(ctx.grants, "foodsafety.manage"))
      push({
        key: "HACCP_REVIEWS_DUE",
        tone: "warning",
        count: await haccpReviewsDue(tx, ctx),
        href: "/food-safety/haccp",
      });

    // Controlled documents (ADR-097): reviews due for managers; unread for everyone in food safety.
    if (holdsAnyGrant(ctx.grants, "foodsafety.manage"))
      push({
        key: "FS_DOCUMENT_REVIEWS_DUE",
        tone: "warning",
        count: await fsDocumentReviewsDue(tx, ctx),
        href: "/food-safety/documents",
      });
    if (holdsAnyGrant(ctx.grants, "foodsafety.view"))
      push({
        key: "FS_DOCUMENTS_UNREAD",
        tone: "info",
        count: await fsDocumentsUnread(tx, ctx),
        href: "/food-safety/documents?unread=1",
      });

    // Complaints to resolve and audits past their planned date (ADR-098).
    if (holdsAnyGrant(ctx.grants, "foodsafety.manage")) {
      const q = await qualityAttention(tx, ctx);
      push({
        key: "COMPLAINTS_OPEN",
        tone: "warning",
        count: q.openComplaints,
        href: "/food-safety/complaints?open=1",
      });
      push({
        key: "AUDITS_OVERDUE",
        tone: "warning",
        count: q.auditsOverdue,
        href: "/food-safety/audits",
      });
    }

    // Equipment calibration and maintenance (ADR-099).
    if (holdsAnyGrant(ctx.grants, "foodsafety.record")) {
      const e = await equipmentAttention(ctx);
      push({
        key: "EQUIPMENT_OVERDUE",
        tone: "danger",
        count: e.overdue,
        href: "/food-safety/equipment",
      });
      push({
        key: "EQUIPMENT_DUE_SOON",
        tone: "warning",
        count: e.dueSoon,
        href: "/food-safety/equipment",
      });
      push({
        key: "EQUIPMENT_OUT_OF_SERVICE",
        tone: "warning",
        count: e.outOfService,
        href: "/food-safety/equipment",
      });
    }

    // Goods sent back whose credit note has not been linked yet (ADR-094).
    if (hasPermission(ctx.grants, "invoices.manage"))
      push({
        key: "SUPPLIER_RETURNS_AWAITING_CREDIT",
        tone: "warning",
        count: await tx.supplierReturn.count({ where: { organizationId: org, status: "POSTED" } }),
        href: "/purchasing/returns?status=POSTED",
      });

    // Quarantined receipt lines waiting for their receiving inspection (ADR-101).
    const inspect = warehouseWhere(ctx, "inventory.quarantine.release");
    if (inspect)
      push({
        key: "INSPECTIONS_WAITING",
        tone: "warning",
        count: await tx.goodsReceiptLine.count({
          where: {
            organizationId: org,
            quarantine: true,
            inspection: null,
            receipt: { status: "POSTED", warehouse: inspect },
          },
        }),
        href: "/inventory/inspections",
      });

    // Import shipments past their ETA and not yet arrived (ADR-113).
    const trade = warehouseWhere(ctx, "trade.view");
    if (trade) {
      const late = await tx.importShipment.findMany({
        where: {
          organizationId: org,
          status: { in: ["PLANNED", "IN_TRANSIT"] },
          eta: { lt: todayDate },
          warehouse: trade,
        },
        select: { id: true, number: true },
        orderBy: { eta: "asc" },
      });
      push({
        key: "IMPORT_SHIPMENTS_LATE",
        tone: "warning",
        count: late.length,
        href: "/trade/shipments?status=OPEN",
        links: late.slice(0, 5).map((x) => ({ label: x.number, href: `/trade/shipments/${x.id}` })),
      });
      // Trade documents (ADR-114): product documents, and those of shipments not yet closed.
      const docs = await tx.tradeDocument.findMany({
        where: {
          organizationId: org,
          archivedAt: null,
          expiresOn: { lte: new Date(`${addDays(today, TRADE_DOC_WARNING_DAYS)}T00:00:00Z`) },
          OR: [
            { productId: { not: null } },
            { shipment: { status: { notIn: ["CLOSED", "CANCELLED"] }, warehouse: trade } },
          ],
        },
        select: { id: true, expiresOn: true },
        orderBy: { expiresOn: "asc" },
      });
      const expired = docs.filter((d) => d.expiresOn! < todayDate);
      const expiring = docs.filter((d) => d.expiresOn! >= todayDate);
      const docLinks = (rows: typeof docs) =>
        rows.slice(0, 5).map((d) => ({
          label: d.expiresOn!.toISOString().slice(0, 10),
          href: `/trade/documents/${d.id}`,
        }));
      push({
        key: "TRADE_DOCUMENTS_EXPIRED",
        tone: "danger",
        count: expired.length,
        href: "/trade/documents?state=EXPIRED",
        links: docLinks(expired),
      });
      push({
        key: "TRADE_DOCUMENTS_EXPIRING",
        tone: "warning",
        count: expiring.length,
        href: "/trade/documents?state=EXPIRING",
        links: docLinks(expiring),
      });
    }

    // Cold-chain excursions on trips in the last 7 days (ADR-116).
    const fleet = warehouseWhere(ctx, "logistics.view");
    if (fleet) {
      const trips = await tx.trip.findMany({
        where: {
          organizationId: org,
          warehouse: fleet,
          readings: {
            some: { excursion: true, readAt: { gte: new Date(`${addDays(today, -7)}T00:00:00Z`) } },
          },
        },
        select: { id: true, number: true },
        orderBy: { plannedOn: "desc" },
      });
      push({
        key: "COLD_CHAIN_EXCURSIONS",
        tone: "danger",
        count: trips.length,
        href: "/logistics/trips",
        links: trips
          .slice(0, 5)
          .map((x) => ({ label: x.number, href: `/logistics/trips/${x.id}` })),
      });
    }

    const order = { danger: 0, warning: 1, info: 2 };
    return items.sort((a, b) => order[a.tone] - order[b.tone]);
  });
}
