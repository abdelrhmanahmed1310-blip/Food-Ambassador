import "server-only";
import { hasPermission, assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { assertDocumentCurrency } from "@/modules/fx/service";
import { documentState, EXPIRY_WARNING_DAYS } from "@/modules/hr/rules";
import { decryptSecret, encryptSecret, integrationKey } from "@/modules/integrations/crypto";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { notifyInTx, recipientsInTx } from "@/modules/notifications/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";
import {
  accountNumberValid,
  ibanProblem,
  lastFour,
  maskedAccount,
  normalizeAccount,
  supplierOrderBlock,
  swiftValid,
  type SupplierStatus,
} from "./compliance-rules";
import { blockSupplierSchema, supplierBankAccountSchema, supplierDocumentSchema } from "./schemas";

/**
 * Supplier compliance (DECISIONS.md ADR-091): approval and blocking,
 * licences and certificates with expiry, and bank accounts kept encrypted
 * and verified by a second person. Orders check the supplier here before
 * they can be submitted or approved.
 */

const bankKey = () => {
  const env = getEnv();
  return integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
};
// Not suppliers.ts's loader: suppliers.ts imports this module.
async function loadSupplier(tx: Tx, ctx: TenantContext, supplierId: string) {
  const supplier = await tx.supplier.findFirst({
    where: { organizationId: ctx.organizationId, id: supplierId },
  });
  if (!supplier) throw notFound("Supplier");
  return supplier;
}
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);

const MESSAGES = {
  SUPPLIER_BLOCKED: "The supplier is blocked",
  SUPPLIER_NOT_APPROVED: "The supplier is waiting for approval",
  SUPPLIER_DOCUMENT_EXPIRED: "A document required to buy from this supplier has expired",
} as const;

/** Expired documents marked "required to buy" on a calendar day. */
async function expiredRequired(tx: Tx, ctx: TenantContext, supplierId: string, today: string) {
  return tx.supplierDocument.findMany({
    where: {
      organizationId: ctx.organizationId,
      supplierId,
      archivedAt: null,
      requiredToBuy: true,
      expiresOn: { lt: asDate(today) },
    },
    select: { id: true, type: true, title: true, expiresOn: true },
    orderBy: { expiresOn: "asc" },
  });
}

/**
 * Refuse an order step the supplier's status or documents do not allow
 * (ADR-091). `today` is the order's business date.
 */
export async function assertSupplierOrderable(
  tx: Tx,
  ctx: TenantContext,
  supplier: { id: string; status: SupplierStatus },
  step: "draft" | "send",
  today: string,
) {
  const expired = step === "send" ? await expiredRequired(tx, ctx, supplier.id, today) : [];
  const block = supplierOrderBlock({
    status: supplier.status,
    expiredRequiredDocuments: expired.length,
    step,
  });
  if (block)
    throw businessRuleViolation(
      block,
      MESSAGES[block],
      expired.length > 0
        ? { documentType: expired[0].type, expiredOn: day(expired[0].expiresOn!) }
        : undefined,
    );
}

/** Whether a new supplier starts waiting for approval. */
export async function initialSupplierStatus(tx: Tx, ctx: TenantContext): Promise<SupplierStatus> {
  const row = await tx.procurementSettings.findUnique({
    where: { organizationId: ctx.organizationId },
    select: { supplierApprovalRequired: true },
  });
  return row?.supplierApprovalRequired ? "PENDING_APPROVAL" : "APPROVED";
}

/** Tell the people who may approve suppliers that one is waiting. */
export async function notifySupplierWaiting(
  tx: Tx,
  ctx: TenantContext,
  supplier: { id: string; code: string },
) {
  const users = await recipientsInTx(tx, ctx, (g) => hasPermission(g, "suppliers.approve"));
  await notifyInTx(tx, ctx.organizationId, users, {
    kind: "SUPPLIER_APPROVAL_NEEDED",
    params: { code: supplier.code },
    entityType: "supplier",
    entityId: supplier.id,
    link: `/suppliers/${supplier.id}`,
  });
}

// ─── Approval and blocking ───

export async function approveSupplier(ctx: TenantContext, supplierId: string) {
  assertPermission(ctx.grants, "suppliers.approve");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    if (supplier.status !== "PENDING_APPROVAL")
      throw businessRuleViolation(
        "SUPPLIER_NOT_PENDING",
        "The supplier is not waiting for approval",
      );
    if (supplier.createdByUserId === ctx.userId)
      throw businessRuleViolation(
        "SUPPLIER_SELF_APPROVAL",
        "A supplier must be approved by someone other than the person who added it",
      );
    await tx.supplier.update({
      where: { id: supplier.id },
      data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.approved",
      entityType: "supplier",
      entityId: supplier.id,
    });
  });
}

export async function blockSupplier(ctx: TenantContext, supplierId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "suppliers.approve");
  const parsed = blockSupplierSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    if (supplier.status === "BLOCKED")
      throw businessRuleViolation("SUPPLIER_BLOCKED", MESSAGES.SUPPLIER_BLOCKED);
    await tx.supplier.update({
      where: { id: supplier.id },
      data: {
        status: "BLOCKED",
        blockedAt: new Date(),
        blockedByUserId: ctx.userId,
        blockedReason: parsed.data.reason,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.blocked",
      entityType: "supplier",
      entityId: supplier.id,
      changes: { reason: parsed.data.reason, from: supplier.status },
    });
  });
}

/**
 * Lift a block. A supplier that was approved (or predates approvals) is
 * approved again; one never approved goes back to waiting for approval.
 */
export async function unblockSupplier(ctx: TenantContext, supplierId: string) {
  assertPermission(ctx.grants, "suppliers.approve");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    if (supplier.status !== "BLOCKED")
      throw businessRuleViolation("SUPPLIER_NOT_BLOCKED", "The supplier is not blocked");
    const neverApproved =
      supplier.approvedAt === null &&
      supplier.createdByUserId !== null &&
      (await initialSupplierStatus(tx, ctx)) === "PENDING_APPROVAL";
    const status = neverApproved ? "PENDING_APPROVAL" : "APPROVED";
    await tx.supplier.update({
      where: { id: supplier.id },
      data: { status, blockedAt: null, blockedByUserId: null, blockedReason: null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.unblocked",
      entityType: "supplier",
      entityId: supplier.id,
      changes: { to: status },
    });
  });
}

// ─── Documents ───

function documentData(d: ReturnType<typeof supplierDocumentSchema.parse>) {
  return {
    type: d.type,
    title: d.title ?? null,
    number: d.number ?? null,
    issuedOn: d.issuedOn ? asDate(d.issuedOn) : null,
    expiresOn: d.expiresOn ? asDate(d.expiresOn) : null,
    requiredToBuy: d.requiredToBuy,
    note: d.note ?? null,
  };
}

export async function addSupplierDocument(
  ctx: TenantContext,
  supplierId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "suppliers.manage");
  const parsed = supplierDocumentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    const doc = await tx.supplierDocument.create({
      data: {
        ...documentData(parsed.data),
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.document_added",
      entityType: "supplier",
      entityId: supplier.id,
      changes: { documentId: doc.id, ...parsed.data },
    });
    return doc;
  });
}

async function loadDocument(tx: Tx, ctx: TenantContext, supplierId: string, documentId: string) {
  const doc = await tx.supplierDocument.findFirst({
    where: { organizationId: ctx.organizationId, supplierId, id: documentId },
  });
  if (!doc) throw notFound("Supplier document");
  return doc;
}

/** Renewals update the number and dates; the change is in the audit log. */
export async function updateSupplierDocument(
  ctx: TenantContext,
  supplierId: string,
  documentId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "suppliers.manage");
  const parsed = supplierDocumentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await loadDocument(tx, ctx, supplierId, documentId);
    if (doc.archivedAt)
      throw businessRuleViolation("DOCUMENT_ARCHIVED", "The document has been removed");
    const data = documentData(parsed.data);
    await tx.supplierDocument.update({ where: { id: doc.id }, data });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.document_updated",
      entityType: "supplier",
      entityId: supplierId,
      changes: {
        documentId: doc.id,
        number: { from: doc.number, to: data.number },
        expiresOn: {
          from: doc.expiresOn ? day(doc.expiresOn) : null,
          to: parsed.data.expiresOn ?? null,
        },
        requiredToBuy: { from: doc.requiredToBuy, to: data.requiredToBuy },
      },
    });
  });
}

export async function archiveSupplierDocument(
  ctx: TenantContext,
  supplierId: string,
  documentId: string,
) {
  assertPermission(ctx.grants, "suppliers.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const doc = await loadDocument(tx, ctx, supplierId, documentId);
    if (doc.archivedAt) return;
    await tx.supplierDocument.update({
      where: { id: doc.id },
      data: { archivedAt: new Date(), archivedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.document_removed",
      entityType: "supplier",
      entityId: supplierId,
      changes: { documentId: doc.id, type: doc.type },
    });
  });
}

// ─── Bank accounts ───

/** Who may see that bank accounts exist (masked): those who add, verify or pay them. */
export function canSeeBankAccounts(ctx: TenantContext) {
  return (
    hasPermission(ctx.grants, "suppliers.bank.manage") ||
    hasPermission(ctx.grants, "suppliers.approve") ||
    hasPermission(ctx.grants, "payments.manage")
  );
}

/** Who may see the full account number: those who maintain or pay it. */
function canRevealBankAccounts(ctx: TenantContext) {
  return (
    hasPermission(ctx.grants, "suppliers.bank.manage") ||
    hasPermission(ctx.grants, "payments.manage")
  );
}

export async function addSupplierBankAccount(
  ctx: TenantContext,
  supplierId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "suppliers.bank.manage");
  const parsed = supplierBankAccountSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  const account = normalizeAccount(v.account);
  if (v.kind === "IBAN") {
    const problem = ibanProblem(account);
    if (problem)
      throw businessRuleViolation(`IBAN_${problem.toUpperCase()}`, "The IBAN is not valid", {
        field: "account",
      });
  } else if (!accountNumberValid(account))
    throw businessRuleViolation("INVALID_ACCOUNT_NUMBER", "The account number is not valid", {
      field: "account",
    });
  const swiftBic = v.swiftBic ? normalizeAccount(v.swiftBic) : null;
  if (swiftBic && !swiftValid(swiftBic))
    throw businessRuleViolation("INVALID_SWIFT", "The SWIFT/BIC code is not valid", {
      field: "swiftBic",
    });
  // Without an IBAN a bank is identified by its SWIFT code.
  if (v.kind === "ACCOUNT_NUMBER" && !swiftBic)
    throw businessRuleViolation("SWIFT_REQUIRED", "A SWIFT/BIC code is required", {
      field: "swiftBic",
    });
  if (v.currency) assertDocumentCurrency(ctx, v.currency);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    const row = await tx.supplierBankAccount.create({
      data: {
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        bankName: v.bankName,
        accountName: v.accountName,
        kind: v.kind,
        accountSealed: encryptSecret(account, bankKey()),
        accountLast4: lastFour(account),
        swiftBic,
        currency: v.currency ?? null,
        createdByUserId: ctx.userId,
      },
      select: { id: true, accountLast4: true },
    });
    // The account number itself never goes into the audit log.
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.bank_account_added",
      entityType: "supplier",
      entityId: supplier.id,
      changes: {
        bankAccountId: row.id,
        bankName: v.bankName,
        accountName: v.accountName,
        kind: v.kind,
        accountLast4: row.accountLast4,
        swiftBic,
        currency: v.currency ?? null,
      },
    });
    // A changed bank account is the classic payment fraud: the people who
    // verify accounts are told at once.
    const users = await recipientsInTx(tx, ctx, (g) => hasPermission(g, "suppliers.approve"));
    await notifyInTx(tx, ctx.organizationId, users, {
      kind: "SUPPLIER_BANK_ACCOUNT_ADDED",
      params: { code: supplier.code, last4: row.accountLast4 },
      entityType: "supplier",
      entityId: supplier.id,
      link: `/suppliers/${supplier.id}`,
    });
    return { id: row.id };
  });
}

async function loadBankAccount(tx: Tx, ctx: TenantContext, supplierId: string, accountId: string) {
  const row = await tx.supplierBankAccount.findFirst({
    where: { organizationId: ctx.organizationId, supplierId, id: accountId },
  });
  if (!row) throw notFound("Bank account");
  return row;
}

export async function verifySupplierBankAccount(
  ctx: TenantContext,
  supplierId: string,
  accountId: string,
) {
  assertPermission(ctx.grants, "suppliers.approve");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const row = await loadBankAccount(tx, ctx, supplierId, accountId);
    if (row.archivedAt)
      throw businessRuleViolation("BANK_ACCOUNT_ARCHIVED", "The bank account has been removed");
    if (row.verifiedAt)
      throw businessRuleViolation("BANK_ACCOUNT_VERIFIED", "The bank account is already verified");
    if (row.createdByUserId === ctx.userId)
      throw businessRuleViolation(
        "BANK_ACCOUNT_SELF_VERIFICATION",
        "A bank account must be verified by someone other than the person who added it",
      );
    await tx.supplierBankAccount.update({
      where: { id: row.id },
      data: { verifiedAt: new Date(), verifiedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.bank_account_verified",
      entityType: "supplier",
      entityId: supplierId,
      changes: { bankAccountId: row.id, accountLast4: row.accountLast4 },
    });
  });
}

export async function archiveSupplierBankAccount(
  ctx: TenantContext,
  supplierId: string,
  accountId: string,
) {
  assertPermission(ctx.grants, "suppliers.bank.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const row = await loadBankAccount(tx, ctx, supplierId, accountId);
    if (row.archivedAt) return;
    await tx.supplierBankAccount.update({
      where: { id: row.id },
      data: { archivedAt: new Date(), archivedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.bank_account_removed",
      entityType: "supplier",
      entityId: supplierId,
      changes: { bankAccountId: row.id, accountLast4: row.accountLast4 },
    });
  });
}

/** The full account number, for paying the supplier. Each look is in the audit log. */
export async function revealSupplierBankAccount(
  ctx: TenantContext,
  supplierId: string,
  accountId: string,
) {
  if (!canRevealBankAccounts(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const row = await loadBankAccount(tx, ctx, supplierId, accountId);
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.bank_account_revealed",
      entityType: "supplier",
      entityId: supplierId,
      changes: { bankAccountId: row.id, accountLast4: row.accountLast4 },
    });
    return { account: decryptSecret(row.accountSealed, bankKey()) };
  });
}

// ─── The supplier page ───

/** Status, documents (with their state today) and bank accounts (masked) for the supplier page. */
export async function supplierCompliance(ctx: TenantContext, supplierId: string) {
  assertPermission(ctx.grants, "suppliers.view");
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    const [documents, accounts] = [
      await tx.supplierDocument.findMany({
        where: { organizationId: ctx.organizationId, supplierId: supplier.id, archivedAt: null },
        orderBy: [{ expiresOn: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      }),
      canSeeBankAccounts(ctx)
        ? await tx.supplierBankAccount.findMany({
            where: {
              organizationId: ctx.organizationId,
              supplierId: supplier.id,
              archivedAt: null,
            },
            orderBy: { createdAt: "asc" },
          })
        : [],
    ];
    const userIds = [
      ...accounts.flatMap((a) => [a.createdByUserId, a.verifiedByUserId]),
      supplier.blockedByUserId,
      supplier.approvedByUserId,
    ].filter((u): u is string => Boolean(u));
    const users = new Map(
      (
        await tx.user.findMany({
          where: { id: { in: [...new Set(userIds)] } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u.name]),
    );
    const docs = documents.map((d) => ({
      id: d.id,
      type: d.type,
      title: d.title,
      number: d.number,
      issuedOn: d.issuedOn ? day(d.issuedOn) : null,
      expiresOn: d.expiresOn ? day(d.expiresOn) : null,
      requiredToBuy: d.requiredToBuy,
      note: d.note,
      state: documentState(d.expiresOn ? day(d.expiresOn) : null, today),
    }));
    return {
      status: supplier.status,
      createdByUserId: supplier.createdByUserId,
      approvedAt: supplier.approvedAt,
      approvedBy: supplier.approvedByUserId ? (users.get(supplier.approvedByUserId) ?? null) : null,
      blockedAt: supplier.blockedAt,
      blockedBy: supplier.blockedByUserId ? (users.get(supplier.blockedByUserId) ?? null) : null,
      blockedReason: supplier.blockedReason,
      documents: docs,
      /** Expired documents that stop orders being sent. */
      expiredRequired: docs.filter((d) => d.requiredToBuy && d.state === "EXPIRED").length,
      bankAccounts: accounts.map((a) => ({
        id: a.id,
        bankName: a.bankName,
        accountName: a.accountName,
        kind: a.kind,
        masked: maskedAccount(a.accountLast4),
        swiftBic: a.swiftBic,
        currency: a.currency,
        createdByUserId: a.createdByUserId,
        createdBy: users.get(a.createdByUserId) ?? null,
        createdAt: a.createdAt,
        verifiedAt: a.verifiedAt,
        verifiedBy: a.verifiedByUserId ? (users.get(a.verifiedByUserId) ?? null) : null,
      })),
      canReveal: canRevealBankAccounts(ctx),
    };
  });
}

/** Supplier documents expiring within the warning window or already expired (attention list). */
export async function supplierDocumentsDue(tx: Tx, ctx: TenantContext) {
  const today = businessDate(ctx.timeZone);
  const soon = addDays(today, EXPIRY_WARNING_DAYS);
  const rows = await tx.supplierDocument.findMany({
    where: {
      organizationId: ctx.organizationId,
      archivedAt: null,
      expiresOn: { lte: asDate(soon) },
      supplier: { archivedAt: null },
    },
    select: {
      expiresOn: true,
      supplier: { select: { id: true, code: true, name: true } },
    },
    orderBy: { expiresOn: "asc" },
  });
  const expired = rows.filter((r) => day(r.expiresOn!) < today);
  const expiring = rows.filter((r) => day(r.expiresOn!) >= today);
  return { expired, expiring };
}
