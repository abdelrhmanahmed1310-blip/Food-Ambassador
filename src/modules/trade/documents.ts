import "server-only";
import { z } from "zod";
import { isCountryCode } from "@/lib/countries";
import { isCalendarDate } from "@/lib/dates";
import { isUuid } from "@/lib/uuid";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { codeSchema, optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import { applicable, checklist, EXPIRY_WARNING_DAYS, expiryState } from "./document-rules";

/**
 * Trade documents and requirements (DECISIONS.md ADR-114). Document types
 * and the requirements for them are the organization's own; none are
 * created for it and no authority's rules are assumed. Shipment documents
 * follow the shipment's warehouse scope (`trade.view` / `trade.manage`);
 * product documents, types and requirements need those permissions for
 * the whole organization to change.
 */

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string | undefined | null) => (s ? new Date(`${s}T00:00:00Z`) : null);
const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });
const optionalCountry = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim().toUpperCase() : undefined))
  .refine((v) => v === undefined || isCountryCode(v), { error: "invalidOption" });

const typeSchema = z.object({
  code: codeSchema,
  name: requiredText(120),
  nameAr: optionalText(120),
  scope: z.enum(["SHIPMENT", "PRODUCT"], { error: "invalidOption" }),
  hasExpiry: z
    .union([z.boolean(), z.enum(["on", "true", "false"])])
    .optional()
    .transform((v) => v === true || v === "on" || v === "true"),
});

const requirementSchema = z.object({
  documentTypeId: uuidSchema,
  destinationCountry: optionalCountry,
  originCountry: optionalCountry,
  hsPrefix: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/[\s.]/g, "") : undefined) || undefined)
    .refine((v) => v === undefined || /^[0-9]{2,12}$/.test(v), { error: "invalidHsPrefix" }),
  authority: optionalText(120),
  note: optionalText(500),
});

const documentFields = {
  number: optionalText(80),
  issuedBy: optionalText(160),
  issuedOn: optionalDate,
  expiresOn: optionalDate,
  note: optionalText(500),
};
const documentSchema = z
  .object({ documentTypeId: uuidSchema, ...documentFields })
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, {
    error: "expiryBeforeIssue",
    path: ["expiresOn"],
  });
const renewSchema = z
  .object(documentFields)
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, {
    error: "expiryBeforeIssue",
    path: ["expiresOn"],
  });

export const canSeeTradeDocuments = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "trade.view");
/** Types, requirements and product documents are organization-wide. */
export const canManageTradeSetup = (ctx: TenantContext) =>
  hasPermission(ctx.grants, "trade.manage");

function assertSetup(ctx: TenantContext) {
  if (!canManageTradeSetup(ctx)) throw forbidden();
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  id: string,
  action: string,
  changes: Record<string, unknown>,
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${entityType}.${action}`,
    entityType,
    entityId: id,
    changes,
  });
}

// ─── Set-up ───

export async function createDocumentType(ctx: TenantContext, rawInput: unknown) {
  assertSetup(ctx);
  const parsed = typeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const t = await tx.tradeDocumentType.create({
        data: {
          organizationId: ctx.organizationId,
          ...parsed.data,
          nameAr: parsed.data.nameAr ?? null,
        },
        select: { id: true, code: true },
      });
      await audit(tx, ctx, "trade_document_type", t.id, "created", parsed.data);
      return t;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Code already used", { reason: "codeTaken", field: "code" });
    throw error;
  }
}

export async function setDocumentTypeArchived(
  ctx: TenantContext,
  typeId: string,
  archived: boolean,
) {
  assertSetup(ctx);
  await withTenantTx(ctx.organizationId, async (tx) => {
    if (!isUuid(typeId)) throw notFound("DocumentType");
    const moved = await tx.tradeDocumentType.updateMany({
      where: { organizationId: ctx.organizationId, id: typeId },
      data: { archivedAt: archived ? new Date() : null },
    });
    if (!moved.count) throw notFound("DocumentType");
    await audit(tx, ctx, "trade_document_type", typeId, archived ? "archived" : "restored", {});
  });
}

export async function createRequirement(ctx: TenantContext, rawInput: unknown) {
  assertSetup(ctx);
  const parsed = requirementSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const r = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const type = await tx.tradeDocumentType.findFirst({
      where: { organizationId: ctx.organizationId, id: r.documentTypeId, archivedAt: null },
      select: { id: true },
    });
    if (!type) throw notFound("DocumentType");
    const created = await tx.tradeRequirement.create({
      data: {
        organizationId: ctx.organizationId,
        documentTypeId: type.id,
        destinationCountry: r.destinationCountry ?? null,
        originCountry: r.originCountry ?? null,
        hsPrefix: r.hsPrefix ?? null,
        authority: r.authority ?? null,
        note: r.note ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await audit(tx, ctx, "trade_requirement", created.id, "created", r);
    return created;
  });
}

/** Requirements are never edited: a change is a new one and the old one archived. */
export async function archiveRequirement(ctx: TenantContext, requirementId: string) {
  assertSetup(ctx);
  await withTenantTx(ctx.organizationId, async (tx) => {
    if (!isUuid(requirementId)) throw notFound("Requirement");
    const moved = await tx.tradeRequirement.updateMany({
      where: { organizationId: ctx.organizationId, id: requirementId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (!moved.count) throw notFound("Requirement");
    await audit(tx, ctx, "trade_requirement", requirementId, "archived", {});
  });
}

export async function tradeSetup(ctx: TenantContext) {
  if (!canSeeTradeDocuments(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [types, requirements] = await Promise.all([
      tx.tradeDocumentType.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { code: "asc" },
      }),
      tx.tradeRequirement.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        include: {
          documentType: { select: { code: true, name: true, nameAr: true, scope: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return { types, requirements, canManage: canManageTradeSetup(ctx) };
  });
}

// ─── Documents ───

async function loadType(tx: Tx, ctx: TenantContext, typeId: string, scope: "SHIPMENT" | "PRODUCT") {
  const type = await tx.tradeDocumentType.findFirst({
    where: { organizationId: ctx.organizationId, id: typeId, archivedAt: null },
  });
  if (!type) throw notFound("DocumentType");
  if (type.scope !== scope)
    throw businessRuleViolation(
      "DOCUMENT_TYPE_OTHER_SCOPE",
      "This kind of document is held elsewhere",
      {
        field: "documentTypeId",
      },
    );
  return type;
}

function assertExpiry(type: { hasExpiry: boolean }, expiresOn: string | undefined) {
  if (type.hasExpiry && !expiresOn)
    throw businessRuleViolation("DOCUMENT_NEEDS_EXPIRY", "This document has an expiry date", {
      field: "expiresOn",
    });
}

const shipmentTarget = (s: { warehouseId: string; warehouse: { branchId: string } }) => ({
  warehouseId: s.warehouseId,
  branchId: s.warehouse.branchId,
});

/** A document for one shipment (commercial invoice, certificate of origin, health certificate). */
export async function addShipmentDocument(
  ctx: TenantContext,
  shipmentId: string,
  rawInput: unknown,
) {
  const parsed = documentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    if (!isUuid(shipmentId)) throw notFound("Shipment");
    const s = await tx.importShipment.findFirst({
      where: { organizationId: ctx.organizationId, id: shipmentId },
      select: {
        id: true,
        status: true,
        warehouseId: true,
        warehouse: { select: { branchId: true } },
      },
    });
    if (!s || !hasPermission(ctx.grants, "trade.view", shipmentTarget(s)))
      throw notFound("Shipment");
    if (!hasPermission(ctx.grants, "trade.manage", shipmentTarget(s))) throw forbidden();
    if (s.status === "CANCELLED" || s.status === "CLOSED")
      throw businessRuleViolation("SHIPMENT_NOT_EDITABLE", "The shipment is closed or cancelled");
    const type = await loadType(tx, ctx, input.documentTypeId, "SHIPMENT");
    assertExpiry(type, input.expiresOn);
    return createDocumentInTx(tx, ctx, { ...input, shipmentId: s.id });
  });
}

/** A document held for a product (product registration, import permit). */
export async function addProductDocument(ctx: TenantContext, rawInput: unknown) {
  assertSetup(ctx);
  const parsed = documentSchema.and(z.object({ productId: uuidSchema })).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const product = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, id: input.productId },
      select: { id: true },
    });
    if (!product) throw notFound("Product");
    const type = await loadType(tx, ctx, input.documentTypeId, "PRODUCT");
    assertExpiry(type, input.expiresOn);
    return createDocumentInTx(tx, ctx, { ...input, productId: product.id });
  });
}

async function createDocumentInTx(
  tx: Tx,
  ctx: TenantContext,
  d: z.output<typeof documentSchema> & { shipmentId?: string; productId?: string },
) {
  const doc = await tx.tradeDocument.create({
    data: {
      organizationId: ctx.organizationId,
      documentTypeId: d.documentTypeId,
      shipmentId: d.shipmentId ?? null,
      productId: d.productId ?? null,
      number: d.number ?? null,
      issuedBy: d.issuedBy ?? null,
      issuedOn: toDate(d.issuedOn),
      expiresOn: toDate(d.expiresOn),
      note: d.note ?? null,
      createdByUserId: ctx.userId,
    },
    select: { id: true },
  });
  await audit(tx, ctx, "trade_document", doc.id, "created", { ...d });
  return doc;
}

async function loadDocument(tx: Tx, ctx: TenantContext, documentId: string) {
  if (!isUuid(documentId)) throw notFound("Document");
  const d = await tx.tradeDocument.findFirst({
    where: { organizationId: ctx.organizationId, id: documentId },
    include: {
      documentType: true,
      product: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
      shipment: {
        select: {
          id: true,
          number: true,
          status: true,
          warehouseId: true,
          warehouse: { select: { branchId: true } },
        },
      },
    },
  });
  if (!d) throw notFound("Document");
  const where = d.shipment ? shipmentTarget(d.shipment) : undefined;
  if (d.shipment ? !hasPermission(ctx.grants, "trade.view", where) : !canSeeTradeDocuments(ctx))
    throw notFound("Document");
  const canManage = d.shipment
    ? hasPermission(ctx.grants, "trade.manage", where)
    : canManageTradeSetup(ctx);
  return { ...d, canManage };
}

export async function getTradeDocument(ctx: TenantContext, documentId: string) {
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDocument(tx, ctx, documentId);
    return {
      ...d,
      issuedOn: day(d.issuedOn),
      expiresOn: day(d.expiresOn),
      state: d.archivedAt ? null : expiryState(day(d.expiresOn), today),
      canManage: d.canManage && !d.archivedAt,
    };
  });
}

/** Renewal: new number and dates on the same record; audited. */
export async function renewTradeDocument(
  ctx: TenantContext,
  documentId: string,
  rawInput: unknown,
) {
  const parsed = renewSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDocument(tx, ctx, documentId);
    if (!d.canManage) throw forbidden();
    if (d.archivedAt) throw businessRuleViolation("DOCUMENT_ARCHIVED", "The document was removed");
    assertExpiry(d.documentType, parsed.data.expiresOn);
    const data = {
      number: parsed.data.number ?? null,
      issuedBy: parsed.data.issuedBy ?? null,
      issuedOn: toDate(parsed.data.issuedOn),
      expiresOn: toDate(parsed.data.expiresOn),
      note: parsed.data.note ?? null,
    };
    await tx.tradeDocument.update({ where: { id: d.id }, data });
    await audit(tx, ctx, "trade_document", d.id, "renewed", {
      from: { number: d.number, expiresOn: day(d.expiresOn) },
      to: { number: data.number, expiresOn: parsed.data.expiresOn ?? null },
    });
  });
}

export async function archiveTradeDocument(
  ctx: TenantContext,
  documentId: string,
  rawInput: unknown,
) {
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDocument(tx, ctx, documentId);
    if (!d.canManage) throw forbidden();
    const moved = await tx.tradeDocument.updateMany({
      where: { organizationId: ctx.organizationId, id: d.id, archivedAt: null },
      data: {
        archivedAt: new Date(),
        archivedByUserId: ctx.userId,
        archiveReason: parsed.data.reason,
      },
    });
    if (!moved.count) throw businessRuleViolation("DOCUMENT_ARCHIVED", "The document was removed");
    await audit(tx, ctx, "trade_document", d.id, "archived", { reason: parsed.data.reason });
  });
}

const listSchema = z.object({
  state: z
    .union([z.literal(""), z.enum(["EXPIRING", "EXPIRED"])])
    .optional()
    .transform((v) => v || undefined),
  typeId: z
    .string()
    .optional()
    .transform((v) => (v && isUuid(v) ? v : undefined)),
  productId: z
    .string()
    .optional()
    .transform((v) => (v && isUuid(v) ? v : undefined)),
});

function shipmentScope(ctx: TenantContext) {
  const s = accessibleScope(ctx.grants, "trade.view");
  return s.all
    ? {}
    : {
        OR: [
          { warehouseId: { in: s.warehouseIds } },
          { warehouse: { branchId: { in: s.branchIds } } },
        ],
      };
}

/** Product documents, and documents of shipments the user may see; current ones only. */
export async function listTradeDocuments(ctx: TenantContext, rawFilters: unknown = {}) {
  if (!canSeeTradeDocuments(ctx)) throw forbidden();
  const f = listSchema.parse(rawFilters);
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.tradeDocument.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        OR: [
          { productId: { not: null } },
          { shipmentId: { not: null }, shipment: { is: shipmentScope(ctx) } },
        ],
        ...(f.typeId ? { documentTypeId: f.typeId } : {}),
        ...(f.productId ? { productId: f.productId } : {}),
        ...(f.state === "EXPIRED"
          ? { expiresOn: { lt: toDate(today)! } }
          : f.state === "EXPIRING"
            ? {
                expiresOn: {
                  gte: toDate(today)!,
                  lte: toDate(addDays(today, EXPIRY_WARNING_DAYS))!,
                },
              }
            : {}),
      },
      include: {
        documentType: { select: { code: true, name: true, nameAr: true, scope: true } },
        product: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
        shipment: { select: { id: true, number: true } },
      },
      orderBy: [{ expiresOn: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 1000,
    });
    return rows.map((d) => ({
      ...d,
      issuedOn: day(d.issuedOn),
      expiresOn: day(d.expiresOn),
      state: expiryState(day(d.expiresOn), today),
    }));
  });
}

export async function tradeDocumentOptions(ctx: TenantContext) {
  if (!canSeeTradeDocuments(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [types, products] = await Promise.all([
      tx.tradeDocumentType.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true, nameAr: true, scope: true, hasExpiry: true },
        orderBy: { code: "asc" },
      }),
      tx.product.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, sku: true, nameEn: true },
        orderBy: { sku: "asc" },
        take: 2000,
      }),
    ]);
    return { types, products };
  });
}

// ─── The shipment's checklist ───

/**
 * What the shipment needs, from the requirements, its company's country,
 * its origin and the products on its orders; and the documents held for it
 * and for those products. Products with no HS code or origin are named:
 * requirements cannot be matched to them.
 */
export async function shipmentChecklistInTx(tx: Tx, ctx: TenantContext, shipmentId: string) {
  const today = businessDate(ctx.timeZone);
  const s = await tx.importShipment.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: shipmentId },
    select: {
      id: true,
      originCountry: true,
      company: { select: { country: true } },
      orders: {
        select: {
          purchaseOrder: {
            select: {
              lines: {
                select: {
                  product: {
                    select: {
                      id: true,
                      sku: true,
                      nameEn: true,
                      nameAr: true,
                      hsCode: true,
                      originCountry: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const products = [
    ...new Map(
      s.orders.flatMap((o) => o.purchaseOrder.lines.map((l) => [l.product.id, l.product])),
    ).values(),
  ];
  const requirements = await tx.tradeRequirement.findMany({
    where: {
      organizationId: ctx.organizationId,
      archivedAt: null,
      documentType: { archivedAt: null },
    },
    include: {
      documentType: { select: { id: true, code: true, name: true, nameAr: true, scope: true } },
    },
  });
  const applied = applicable(
    requirements.map((r) => ({ ...r, scope: r.documentType.scope })),
    { destination: s.company.country, origin: s.originCountry, products },
  );
  const docs = await tx.tradeDocument.findMany({
    where: {
      organizationId: ctx.organizationId,
      archivedAt: null,
      OR: [{ shipmentId: s.id }, { productId: { in: products.map((p) => p.id) } }],
    },
    select: {
      id: true,
      documentTypeId: true,
      shipmentId: true,
      productId: true,
      expiresOn: true,
      number: true,
    },
  });
  const lines = checklist(
    applied,
    docs.map((d) => ({ ...d, expiresOn: day(d.expiresOn) })),
    s.id,
    today,
  );
  const reqOf = new Map(requirements.map((r) => [r.id, r]));
  const productOf = new Map(products.map((p) => [p.id, p]));
  const docOf = new Map(docs.map((d) => [d.id, d]));
  return {
    destinationKnown: s.company.country !== null,
    lines: lines.map((l) => {
      const r = reqOf.get(l.requirementId)!;
      const d = l.documentId ? docOf.get(l.documentId)! : null;
      return {
        ...l,
        documentType: r.documentType,
        authority: r.authority,
        product: l.productId ? productOf.get(l.productId)! : null,
        document: d ? { id: d.id, number: d.number, expiresOn: day(d.expiresOn) } : null,
      };
    }),
    withoutHsCode: products.filter((p) => !p.hsCode).map((p) => p.sku),
    withoutOrigin: s.originCountry
      ? []
      : products.filter((p) => !p.originCountry).map((p) => p.sku),
  };
}
