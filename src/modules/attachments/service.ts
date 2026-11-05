import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import { fsDocumentVersionAccess } from "@/modules/foodsafety/documents";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import { uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { logger } from "@/server/logger";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import {
  MAX_ATTACHMENT_BYTES,
  canStillRemove,
  retainUntil,
  safeFileName,
  sniffContentType,
} from "./rules";
import { scanWithClamd } from "./scanner";

/**
 * Attachments (DECISIONS.md ADR-051, Q-08): PDF or image files of at most
 * 3 MB on purchasing, payables and stock-count documents, kept 3 years.
 * Whoever may see the document may see its files; whoever may work on it
 * may add files. Content is stored in PostgreSQL (attachment_contents)
 * until a hosting decision (Q-03) brings object storage.
 */

export const ATTACHMENT_ENTITIES = [
  "PURCHASE_ORDER",
  "GOODS_RECEIPT",
  "SUPPLIER_INVOICE",
  "SUPPLIER_SETTLEMENT",
  "STOCK_COUNT",
  "SUPPLIER_DOCUMENT",
  "QUOTATION",
  "FS_DOCUMENT_VERSION",
  "CALIBRATION",
  "EXPENSE",
  "IMPORT_SHIPMENT",
  "TRADE_DOCUMENT",
  "TRIP_STOP",
  "TRAINING_RECORD",
] as const;
export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number];

type Access = { view: boolean; upload: boolean };

/** Who may see / add files on a document, by the document's own rules. Not found = not visible. */
async function accessTo(
  tx: Tx,
  ctx: TenantContext,
  entityType: AttachmentEntity,
  entityId: string,
): Promise<Access> {
  const org = ctx.organizationId;
  const onSite = async (
    wh: { id: string; branchId: string } | null | undefined,
    view: Permission,
    upload: Permission,
  ) => {
    if (!wh) throw notFound("Document");
    const target = { branchId: wh.branchId, warehouseId: wh.id };
    const access = {
      view: hasPermission(ctx.grants, view, target),
      upload: hasPermission(ctx.grants, upload, target),
    };
    if (!access.view) throw notFound("Document");
    return access;
  };
  const orgWide = (exists: boolean, view: Permission, upload: Permission) => {
    if (!exists || !hasPermission(ctx.grants, view)) throw notFound("Document");
    return { view: true, upload: hasPermission(ctx.grants, upload) };
  };
  const warehouse = { select: { id: true, branchId: true } } as const;
  switch (entityType) {
    case "PURCHASE_ORDER":
      return onSite(
        (
          await tx.purchaseOrder.findFirst({
            where: { organizationId: org, id: entityId },
            select: { warehouse },
          })
        )?.warehouse,
        "purchasing.view",
        "purchasing.manage",
      );
    case "GOODS_RECEIPT":
      return onSite(
        (
          await tx.goodsReceipt.findFirst({
            where: { organizationId: org, id: entityId },
            select: { warehouse },
          })
        )?.warehouse,
        "purchasing.view",
        "purchasing.receive",
      );
    case "STOCK_COUNT":
      return onSite(
        (
          await tx.stockCount.findFirst({
            where: { organizationId: org, id: entityId },
            select: { warehouse },
          })
        )?.warehouse,
        "inventory.view",
        "inventory.count",
      );
    case "SUPPLIER_INVOICE":
      return orgWide(
        (await tx.supplierInvoice.count({ where: { organizationId: org, id: entityId } })) > 0,
        "invoices.view",
        "invoices.manage",
      );
    case "EXPENSE": {
      // A receipt or invoice for an operating expense (ADR-109), at its branch; not after reversal.
      const e = await tx.expense.findFirst({
        where: { organizationId: org, id: entityId },
        select: { branchId: true, status: true },
      });
      if (!e || !hasPermission(ctx.grants, "expenses.view", { branchId: e.branchId }))
        throw notFound("Document");
      return {
        view: true,
        upload:
          e.status === "POSTED" &&
          hasPermission(ctx.grants, "expenses.manage", { branchId: e.branchId }),
      };
    }
    case "TRIP_STOP": {
      // Photos at a delivery stop (ADR-116): the trip's warehouse; added by its driver or planners while on the road.
      const st = await tx.tripStop.findFirst({
        where: { organizationId: org, id: entityId },
        select: {
          trip: {
            select: {
              status: true,
              driverUserId: true,
              warehouseId: true,
              warehouse: { select: { branchId: true } },
            },
          },
        },
      });
      const where = st
        ? { warehouseId: st.trip.warehouseId, branchId: st.trip.warehouse.branchId }
        : undefined;
      if (!st || !hasPermission(ctx.grants, "logistics.view", where)) throw notFound("Document");
      const mayRecord =
        hasPermission(ctx.grants, "logistics.deliver", where) &&
        (st.trip.driverUserId === ctx.userId ||
          hasPermission(ctx.grants, "logistics.manage", where));
      return { view: true, upload: st.trip.status === "IN_PROGRESS" && mayRecord };
    }
    case "TRAINING_RECORD": {
      // A certificate on a training record (ADR-125): the employee's branch; the employee sees their own.
      const r = await tx.trainingRecord.findFirst({
        where: { organizationId: org, id: entityId },
        select: { voidedAt: true, employee: { select: { branchId: true, userId: true } } },
      });
      const where = r ? { branchId: r.employee.branchId } : undefined;
      const own = !!r && r.employee.userId === ctx.userId;
      if (
        !r ||
        (!own &&
          !hasPermission(ctx.grants, "training.view", where) &&
          !hasPermission(ctx.grants, "training.manage", where))
      )
        throw notFound("Document");
      return {
        view: true,
        upload: !r.voidedAt && hasPermission(ctx.grants, "training.manage", where),
      };
    }
    case "TRADE_DOCUMENT": {
      // The scan of a trade document (ADR-114): its shipment's scope, or organization-wide for products.
      const d = await tx.tradeDocument.findFirst({
        where: { organizationId: org, id: entityId },
        select: {
          archivedAt: true,
          shipment: { select: { warehouseId: true, warehouse: { select: { branchId: true } } } },
        },
      });
      const where = d?.shipment
        ? { warehouseId: d.shipment.warehouseId, branchId: d.shipment.warehouse.branchId }
        : undefined;
      if (
        !d ||
        (where
          ? !hasPermission(ctx.grants, "trade.view", where)
          : !holdsAnyGrant(ctx.grants, "trade.view"))
      )
        throw notFound("Document");
      return {
        view: true,
        upload: !d.archivedAt && hasPermission(ctx.grants, "trade.manage", where),
      };
    }
    case "IMPORT_SHIPMENT": {
      // Transport and trade documents of an import shipment (ADR-113), at its warehouse.
      const s = await tx.importShipment.findFirst({
        where: { organizationId: org, id: entityId },
        select: { warehouseId: true, status: true, warehouse: { select: { branchId: true } } },
      });
      const where = s ? { warehouseId: s.warehouseId, branchId: s.warehouse.branchId } : undefined;
      if (!s || !hasPermission(ctx.grants, "trade.view", where)) throw notFound("Document");
      return {
        view: true,
        upload: s.status !== "CANCELLED" && hasPermission(ctx.grants, "trade.manage", where),
      };
    }
    case "CALIBRATION": {
      // A calibration certificate (ADR-099), at the equipment's branch.
      const c = await tx.calibration.findFirst({
        where: { organizationId: org, id: entityId },
        select: { equipment: { select: { branchId: true } } },
      });
      if (!c || !hasPermission(ctx.grants, "foodsafety.view", { branchId: c.equipment.branchId }))
        throw notFound("Document");
      return {
        view: true,
        upload: hasPermission(ctx.grants, "foodsafety.record", { branchId: c.equipment.branchId }),
      };
    }
    case "FS_DOCUMENT_VERSION": {
      // A controlled document's file; added only while the version is a draft (ADR-097).
      const access = await fsDocumentVersionAccess(tx, ctx, entityId);
      if (!access) throw notFound("Document");
      return access;
    }
    case "QUOTATION":
      // The supplier's quotation file, at the RFQ's warehouse (ADR-092).
      return onSite(
        (
          await tx.quotation.findFirst({
            where: { organizationId: org, id: entityId },
            select: { rfq: { select: { warehouse } } },
          })
        )?.rfq.warehouse,
        "purchasing.view",
        "purchasing.manage",
      );
    case "SUPPLIER_DOCUMENT":
      // A supplier's licences and certificates (ADR-091).
      return orgWide(
        (await tx.supplierDocument.count({ where: { organizationId: org, id: entityId } })) > 0,
        "suppliers.view",
        "suppliers.manage",
      );
    case "SUPPLIER_SETTLEMENT":
      return orgWide(
        (await tx.supplierSettlement.count({ where: { organizationId: org, id: entityId } })) > 0,
        "invoices.view",
        "payments.manage",
      );
  }
}

const targetSchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITIES, { error: "invalidOption" }),
  entityId: uuidSchema,
});

/** Store a file on a document. The type is taken from the content, never from the name. */
export async function uploadAttachment(
  ctx: TenantContext,
  rawTarget: unknown,
  file: { name: string; bytes: Uint8Array },
) {
  const parsed = targetSchema.safeParse(rawTarget);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { entityType, entityId } = parsed.data;
  if (file.bytes.length === 0 || file.bytes.length > MAX_ATTACHMENT_BYTES)
    throw businessRuleViolation("ATTACHMENT_TOO_LARGE", "Files can be at most 3 MB", {
      field: "file",
      maxMb: 3,
    });
  const contentType = sniffContentType(file.bytes);
  if (!contentType)
    throw businessRuleViolation("ATTACHMENT_TYPE_NOT_ALLOWED", "Only PDF, JPEG, PNG or WebP", {
      field: "file",
    });
  // Check access before scanning, so nobody can use the scanner on a document they cannot change.
  await withTenantTx(ctx.organizationId, async (tx) => {
    const access = await accessTo(tx, ctx, entityType, entityId);
    if (!access.upload) throw forbidden();
  });
  // Virus scan (ADR-055): refused when infected, or when a configured scanner cannot answer.
  const scannerUrl = getEnv().CLAMAV_URL;
  let scannedAt: Date | null = null;
  if (scannerUrl) {
    const scan = await scanWithClamd(scannerUrl, file.bytes);
    if (scan.status === "INFECTED") {
      logger.warn("attachment refused: infected", { entityType, signature: scan.signature });
      await withTenantTx(ctx.organizationId, (tx) =>
        recordAudit(tx, actorOf(ctx), {
          action: "attachment.refused_infected",
          entityType: entityType.toLowerCase(),
          entityId,
          changes: { fileName: safeFileName(file.name, contentType), signature: scan.signature },
        }),
      );
      throw businessRuleViolation("ATTACHMENT_INFECTED", "The file contains malware", {
        field: "file",
      });
    }
    if (scan.status === "ERROR") {
      logger.error("attachment scan failed", { entityType, error: scan.message });
      throw businessRuleViolation("ATTACHMENT_SCAN_FAILED", "The virus scanner is not available", {
        field: "file",
      });
    }
    scannedAt = new Date();
  }
  return withTenantTx(ctx.organizationId, async (tx) => {
    const access = await accessTo(tx, ctx, entityType, entityId);
    if (!access.upload) throw forbidden();
    const today = businessDate(ctx.timeZone);
    const a = await tx.attachment.create({
      data: {
        organizationId: ctx.organizationId,
        entityType,
        entityId,
        fileName: safeFileName(file.name, contentType),
        contentType,
        sizeBytes: file.bytes.length,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        scanStatus: scannedAt ? "CLEAN" : "NOT_SCANNED",
        scannedAt,
        uploadedByUserId: ctx.userId,
        retainUntil: new Date(`${retainUntil(today)}T00:00:00Z`),
      },
      select: { id: true, fileName: true, sizeBytes: true, retainUntil: true, scanStatus: true },
    });
    await tx.attachmentContent.create({
      data: {
        attachmentId: a.id,
        organizationId: ctx.organizationId,
        data: Buffer.from(file.bytes),
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "attachment.uploaded",
      entityType: entityType.toLowerCase(),
      entityId,
      changes: { attachmentId: a.id, fileName: a.fileName, contentType, sizeBytes: a.sizeBytes },
    });
    return a;
  });
}

/** Files on a document (not removed), newest first, with whether the user may remove each. */
export async function listAttachments(
  ctx: TenantContext,
  entityType: AttachmentEntity,
  entityId: string,
) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const access = await accessTo(tx, ctx, entityType, entityId);
    const rows = await tx.attachment.findMany({
      where: { organizationId: ctx.organizationId, entityType, entityId, removedAt: null },
      select: {
        id: true,
        fileName: true,
        contentType: true,
        sizeBytes: true,
        uploadedAt: true,
        uploadedByUserId: true,
        retainUntil: true,
        purgedAt: true,
        scanStatus: true,
      },
      orderBy: { uploadedAt: "desc" },
    });
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.uploadedByUserId))] } },
      select: { id: true, name: true },
    });
    const now = new Date();
    return {
      canUpload: access.upload,
      items: rows.map((r) => ({
        ...r,
        uploadedBy: users.find((u) => u.id === r.uploadedByUserId)?.name ?? null,
        canRemove:
          !r.purgedAt && r.uploadedByUserId === ctx.userId && canStillRemove(r.uploadedAt, now),
      })),
    };
  });
}

/** The bytes of a file the user may see. Removed or purged files are gone. */
export async function getAttachmentContent(ctx: TenantContext, attachmentId: string) {
  if (!uuidSchema.safeParse(attachmentId).success) throw notFound("Attachment");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const a = await tx.attachment.findFirst({
      where: { organizationId: ctx.organizationId, id: attachmentId },
      include: { content: true },
    });
    if (!a) throw notFound("Attachment");
    await accessTo(tx, ctx, a.entityType, a.entityId);
    if (a.removedAt || a.purgedAt || !a.content) throw notFound("Attachment");
    return { fileName: a.fileName, contentType: a.contentType, data: a.content.data };
  });
}

/** Remove a mistaken file: only its uploader, only within the first hour. */
export async function removeAttachment(ctx: TenantContext, attachmentId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const a = await tx.attachment.findFirst({
      where: { organizationId: ctx.organizationId, id: attachmentId, removedAt: null },
    });
    if (!a) throw notFound("Attachment");
    await accessTo(tx, ctx, a.entityType, a.entityId);
    if (a.uploadedByUserId !== ctx.userId || !canStillRemove(a.uploadedAt, new Date()))
      throw businessRuleViolation(
        "ATTACHMENT_RETAINED",
        "Files are kept for three years; only a mistaken upload can be removed, by its uploader, within an hour",
      );
    await tx.attachmentContent.deleteMany({
      where: { organizationId: ctx.organizationId, attachmentId: a.id },
    });
    await tx.attachment.update({
      where: { id: a.id },
      data: { removedAt: new Date(), removedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "attachment.removed",
      entityType: a.entityType.toLowerCase(),
      entityId: a.entityId,
      changes: { attachmentId: a.id, fileName: a.fileName },
    });
  });
}

/**
 * System job (all organizations): delete the content of files whose
 * retention ended before `today`, keeping the record (name, size, hash).
 */
export async function purgeExpiredAttachments(options: { today?: string; limit?: number } = {}) {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  return withSystemTx(async (tx) => {
    const due = await tx.attachment.findMany({
      where: {
        purgedAt: null,
        removedAt: null,
        retainUntil: { lt: new Date(`${today}T00:00:00Z`) },
      },
      select: { id: true, organizationId: true },
      take: options.limit ?? 500,
    });
    for (const a of due) {
      await tx.attachmentContent.deleteMany({ where: { attachmentId: a.id } });
      await tx.attachment.update({ where: { id: a.id }, data: { purgedAt: new Date() } });
    }
    return { purged: due.length };
  });
}
