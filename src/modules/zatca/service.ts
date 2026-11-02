import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import {
  decryptSecret,
  encryptSecret,
  integrationKey,
  retryDelaySeconds,
} from "@/modules/integrations/crypto";
import { optionalText, requiredText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { getEnv } from "@/server/env";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import {
  checkCompliance,
  clearDocument,
  qrOf,
  reportDocument,
  requestComplianceCsid,
  requestProductionCsid,
  type Fetch,
  type ZatcaEnv,
} from "./client";
import {
  buyerProblems,
  FIRST_PIH,
  type TaxCategory,
  type ZatcaBuyer,
  type ZatcaInvoiceInput,
  type ZatcaLine,
  type ZatcaParty,
} from "./invoice";
import { buildCsr, generateDeviceKey, stampInvoice } from "./signing";
import { phase1Qr } from "./tlv";

/**
 * ZATCA e-invoicing for the point of sale in Saudi Arabia (DECISIONS.md
 * ADR-064): seller settings, one e-invoicing unit per register, a signed
 * simplified invoice for every sale and a credit note for every refund or
 * void once the unit is onboarded, and reporting to ZATCA within 24 hours.
 * Before onboarding, receipts carry the Phase 1 QR.
 */

const key = () => {
  const env = getEnv();
  return integrationKey(env.INTEGRATION_ENCRYPTION_KEY, env.AUTH_SECRET);
};
const dec = (v: { toString(): string }) => new Decimal(v.toString());

const CATEGORY: Record<string, TaxCategory> = {
  STANDARD: "S",
  ZERO_RATED: "Z",
  EXEMPT: "E",
  OUT_OF_SCOPE: "O",
};

async function audit(tx: Tx, ctx: TenantContext, entityId: string, action: string, changes = {}) {
  await recordAudit(tx, actorOf(ctx), {
    action: `zatca_device.${action}`,
    entityType: "zatca_device",
    entityId,
    changes,
  });
}

// ─── Settings ───

const settingsSchema = z.object({
  legalName: requiredText(200),
  crNumber: optionalText(20),
  street: requiredText(120),
  building: z
    .string()
    .trim()
    .regex(/^\d{4}$/, { error: "invalid" }),
  district: requiredText(120),
  city: requiredText(80),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, { error: "invalid" }),
  businessCategory: requiredText(80),
  environment: z.enum(["DEVELOPER_PORTAL", "SIMULATION", "CORE"], { error: "invalidOption" }),
});

export async function updateZatcaSettings(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  // ZATCA documents report VAT in riyals; the base currency is fixed (Q-11).
  if (ctx.baseCurrency !== "SAR")
    throw businessRuleViolation(
      "ZATCA_NEEDS_SAR",
      "ZATCA e-invoicing is for organizations whose base currency is the Saudi riyal",
    );
  const parsed = settingsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const data = { ...parsed.data, crNumber: parsed.data.crNumber ?? null };
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.zatcaSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "zatca_settings.updated",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: data,
    });
  });
}

/** Settings, registers with their e-invoicing unit, and recent documents. */
export async function getZatcaSetup(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const org = ctx.organizationId;
    const [settings, tax, registers, documents] = [
      await tx.zatcaSettings.findUnique({ where: { organizationId: org } }),
      await tx.taxSettings.findUnique({ where: { organizationId: org } }),
      await tx.posRegister.findMany({
        where: { organizationId: org, archivedAt: null },
        select: {
          id: true,
          code: true,
          name: true,
          branch: { select: { name: true } },
          zatcaDevice: {
            select: {
              id: true,
              status: true,
              environment: true,
              icv: true,
              onboardedAt: true,
              commonName: true,
            },
          },
        },
        orderBy: { code: "asc" },
      }),
      await tx.zatcaDocument.findMany({
        where: { organizationId: org },
        select: {
          id: true,
          type: true,
          number: true,
          icv: true,
          status: true,
          attempts: true,
          reportedAt: true,
          createdAt: true,
          response: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ];
    const office = await tx.zatcaDevice.findFirst({
      where: { organizationId: org, purpose: "OFFICE" },
      select: { id: true, status: true, environment: true, icv: true, onboardedAt: true },
    });
    const counts = await tx.zatcaDocument.groupBy({
      by: ["status"],
      where: { organizationId: org },
      _count: { _all: true },
    });
    return {
      settings,
      vatRegistered: tax?.vatRegistered ?? false,
      vatNumber: tax?.vatNumber ?? null,
      country: tax?.country ?? null,
      registers,
      office,
      documents,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  });
}

async function seller(tx: Tx, ctx: TenantContext): Promise<ZatcaParty | null> {
  const [s, tax] = [
    await tx.zatcaSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
    await tx.taxSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
  ];
  if (!s || !tax?.vatRegistered || !tax.vatNumber || tax.country !== "SA") return null;
  if (ctx.baseCurrency !== "SAR") return null;
  return {
    name: s.legalName,
    vatNumber: tax.vatNumber.replace(/\s/g, ""),
    crNumber: s.crNumber,
    street: s.street,
    building: s.building,
    district: s.district,
    city: s.city,
    postalCode: s.postalCode,
  };
}

// ─── Devices and onboarding ───

/** Make the register's e-invoicing unit: a new secp256k1 key and its CSR. */
export async function prepareDevice(ctx: TenantContext, registerId: string) {
  return prepareUnit(ctx, registerId);
}

/** Make the back office's unit for standard (B2B) invoices (ADR-072). */
export async function prepareOfficeUnit(ctx: TenantContext) {
  return prepareUnit(ctx, null);
}

async function prepareUnit(ctx: TenantContext, registerId: string | null) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const register = registerId
      ? await tx.posRegister.findFirst({
          where: { organizationId: ctx.organizationId, id: registerId },
          include: { branch: { select: { name: true } }, zatcaDevice: true },
        })
      : null;
    if (registerId && !register) throw notFound("Register");
    const existing = register
      ? register.zatcaDevice
      : await tx.zatcaDevice.findFirst({
          where: { organizationId: ctx.organizationId, purpose: "OFFICE" },
        });
    if (existing && existing.status !== "NEW")
      throw businessRuleViolation("ZATCA_DEVICE_EXISTS", "This unit is already onboarded");
    const party = await seller(tx, ctx);
    const settings = await tx.zatcaSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    if (!party || !settings)
      throw businessRuleViolation(
        "ZATCA_SETUP_INCOMPLETE",
        "Register for VAT in Saudi Arabia and complete the e-invoicing details first",
      );
    const { privateKeyPem } = generateDeviceKey();
    const serialNumber = `1-FoodAmbassador|2-1.0|3-${register?.id ?? `office-${ctx.organizationId}`}`;
    const commonName = register ? `EGS-${register.code}` : "EGS-OFFICE";
    const csr = buildCsr(
      privateKeyPem,
      {
        commonName,
        organization: party.name,
        organizationUnit: register?.branch.name ?? "Head office",
        serialNumber,
        vatNumber: party.vatNumber,
        // Simplified invoices (B2C) from a register; standard invoices (B2B) from the back office.
        invoiceTypes: register ? "0100" : "1000",
        address: `${party.building} ${party.street}, ${party.district}, ${party.city} ${party.postalCode}`,
        businessCategory: settings.businessCategory,
      },
      settings.environment === "DEVELOPER_PORTAL"
        ? "developer-portal"
        : settings.environment === "SIMULATION"
          ? "simulation"
          : "core",
    );
    const data = {
      environment: settings.environment,
      commonName,
      serialNumber,
      status: "NEW" as const,
      privateKeySealed: encryptSecret(privateKeyPem, key()),
      csr,
      lastHash: FIRST_PIH,
      icv: 0,
    };
    const device = existing
      ? await tx.zatcaDevice.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        })
      : await tx.zatcaDevice.create({
          data: {
            organizationId: ctx.organizationId,
            registerId: register?.id ?? null,
            purpose: register ? "POS" : "OFFICE",
            ...data,
          },
          select: { id: true },
        });
    await audit(tx, ctx, device.id, "prepared", {
      register: register?.code ?? "OFFICE",
      environment: settings.environment,
    });
    return device;
  });
}

/** A clearly labelled sample buyer for the standard compliance samples. */
const SAMPLE_BUYER: ZatcaBuyer = {
  name: "Compliance sample buyer",
  vatNumber: "399999999900003",
  street: "Sample street",
  building: "1234",
  district: "Sample district",
  city: "Riyadh",
  postalCode: "12345",
  country: "SA",
};

/** Sample documents for ZATCA's compliance checks (invoice, credit note, debit note). */
function sampleDocuments(
  party: ZatcaParty,
  number: string,
  kind: "SIMPLIFIED" | "STANDARD",
): ZatcaInvoiceInput[] {
  const line: ZatcaLine = {
    name: "Compliance sample",
    quantity: new Decimal(1),
    net: new Decimal(100),
    vat: new Decimal(15),
    category: "S",
    percent: new Decimal(15),
  };
  const now = new Date();
  const base = {
    issueDate: now.toISOString().slice(0, 10),
    issueTime: now.toISOString().slice(11, 19),
    currency: "SAR",
    seller: party,
    paymentMeans: "10" as const,
    lines: [line],
    kind,
    ...(kind === "STANDARD"
      ? { buyer: SAMPLE_BUYER, deliveryDate: now.toISOString().slice(0, 10) }
      : {}),
  };
  return [
    { ...base, type: "INVOICE", number: `${number}-1`, uuid: randomUUID(), icv: 1, pih: FIRST_PIH },
    {
      ...base,
      type: "CREDIT_NOTE",
      number: `${number}-2`,
      uuid: randomUUID(),
      icv: 2,
      pih: FIRST_PIH,
      billingReference: `${number}-1`,
      reason: "Compliance sample",
    },
    {
      ...base,
      type: "DEBIT_NOTE",
      number: `${number}-3`,
      uuid: randomUUID(),
      icv: 3,
      pih: FIRST_PIH,
      billingReference: `${number}-1`,
      reason: "Compliance sample",
    },
  ];
}

const otpSchema = z.object({
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { error: "invalid" }),
});

/**
 * Onboard a unit with the OTP from the Fatoora portal: compliance CSID,
 * compliance checks with signed samples, production CSID. Each step is
 * saved, so a failed step can be retried from where it stopped.
 */
export async function onboardDevice(
  ctx: TenantContext,
  deviceId: string,
  rawInput: unknown,
  fetchImpl: Fetch = fetch,
) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = otpSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const load = () =>
    withTenantTx(ctx.organizationId, async (tx) => {
      const d = await tx.zatcaDevice.findFirst({
        where: { organizationId: ctx.organizationId, id: deviceId },
      });
      if (!d) throw notFound("E-invoicing unit");
      return { device: d, party: await seller(tx, ctx) };
    });
  const first = await load();
  let device = first.device;
  const party = first.party;
  if (!party)
    throw businessRuleViolation("ZATCA_SETUP_INCOMPLETE", "Complete the e-invoicing details first");
  const envName = device.environment as ZatcaEnv;
  const save = (data: Parameters<Tx["zatcaDevice"]["update"]>[0]["data"], action: string) =>
    withTenantTx(ctx.organizationId, async (tx) => {
      await tx.zatcaDevice.update({ where: { id: deviceId }, data });
      await audit(tx, ctx, deviceId, action);
    });
  const fail = (step: string, error: unknown) =>
    businessRuleViolation("ZATCA_ONBOARDING_FAILED", `ZATCA refused the ${step}`, {
      step,
      status: (error as { status?: number | null }).status ?? null,
    });

  if (device.status === "NEW") {
    const csid = await requestComplianceCsid(fetchImpl, envName, device.csr, parsed.data.otp).catch(
      (e) => {
        throw fail("compliance certificate request", e);
      },
    );
    await save(
      {
        status: "COMPLIANCE",
        complianceRequestId: csid.requestId,
        complianceToken: csid.token,
        complianceSecret: encryptSecret(csid.secret, key()),
      },
      "compliance_csid",
    );
    ({ device } = await load());
  }
  if (device.status === "COMPLIANCE") {
    const privateKeyPem = decryptSecret(device.privateKeySealed, key());
    const compliance = {
      requestId: device.complianceRequestId ?? "",
      token: device.complianceToken!,
      secret: decryptSecret(device.complianceSecret!, key()),
    };
    const certificate = Buffer.from(compliance.token, "base64").toString();
    const kind = device.purpose === "OFFICE" ? "STANDARD" : "SIMPLIFIED";
    for (const sample of sampleDocuments(party, `CMP-${device.commonName}`, kind)) {
      const s = stampInvoice(sample, { privateKeyPem, certificate });
      const r = await checkCompliance(fetchImpl, envName, compliance, {
        invoiceHash: s.invoiceHash,
        uuid: sample.uuid,
        invoice: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${s.xml}`).toString("base64"),
      });
      if (!r.passed) throw fail(`compliance check (${sample.type})`, r);
    }
    const production = await requestProductionCsid(fetchImpl, envName, compliance).catch((e) => {
      throw fail("production certificate request", e);
    });
    await save(
      {
        status: "ACTIVE",
        productionToken: production.token,
        productionSecret: encryptSecret(production.secret, key()),
        onboardedAt: new Date(),
      },
      "onboarded",
    );
  }
  return (await load()).device.status;
}

// ─── Issuing ───

interface IssueInput {
  /** The register's unit; null = the back office's unit (standard invoices). */
  registerId: string | null;
  type: "INVOICE" | "CREDIT_NOTE";
  orderId?: string;
  refundId?: string;
  /** Standard (B2B) documents (ADR-072). */
  kind?: "SIMPLIFIED" | "STANDARD";
  salesInvoiceId?: string;
  buyer?: ZatcaBuyer;
  deliveryDate?: string;
  currency?: string;
  vatInSar?: Decimal;
  number: string;
  issuedAt: Date;
  timeZone: string;
  paymentMeans: "1" | "10" | "48";
  lines: ZatcaLine[];
  billingReference?: string;
  reason?: string;
}

function localDateTime(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

/**
 * Sign the next document of the register's unit, if it is onboarded: the
 * unit row is locked so its counter and hash chain advance one at a time.
 */
async function issueInTx(tx: Tx, ctx: TenantContext, a: IssueInput) {
  const found = await tx.zatcaDevice.findFirst({
    where: {
      organizationId: ctx.organizationId,
      status: "ACTIVE",
      ...(a.registerId ? { registerId: a.registerId } : { purpose: "OFFICE" as const }),
    },
    select: { id: true },
  });
  if (!found || a.lines.length === 0) return null;
  await tx.$queryRaw`SELECT 1 FROM "zatca_devices" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
  const device = await tx.zatcaDevice.findUniqueOrThrow({ where: { id: found.id } });
  const party = await seller(tx, ctx);
  if (!party) return null;
  const { date, time } = localDateTime(a.issuedAt, a.timeZone);
  const input: ZatcaInvoiceInput = {
    type: a.type,
    number: a.number,
    uuid: randomUUID(),
    issueDate: date,
    issueTime: time,
    icv: device.icv + 1,
    pih: device.lastHash,
    currency: a.currency ?? ctx.baseCurrency,
    kind: a.kind ?? "SIMPLIFIED",
    buyer: a.buyer,
    deliveryDate: a.deliveryDate,
    vatInSar: a.vatInSar,
    seller: party,
    paymentMeans: a.paymentMeans,
    lines: a.lines,
    billingReference: a.billingReference,
    reason: a.reason,
  };
  const stamped = stampInvoice(input, {
    privateKeyPem: decryptSecret(device.privateKeySealed, key()),
    certificate: Buffer.from(device.productionToken!, "base64").toString(),
  });
  await tx.zatcaDocument.create({
    data: {
      organizationId: ctx.organizationId,
      deviceId: device.id,
      type: a.type,
      orderId: a.orderId ?? null,
      refundId: a.refundId ?? null,
      kind: a.kind ?? "SIMPLIFIED",
      salesInvoiceId: a.salesInvoiceId ?? null,
      number: a.number,
      uuid: input.uuid,
      icv: input.icv,
      pih: input.pih,
      invoiceHash: stamped.invoiceHash,
      xml: stamped.xml,
      qr: stamped.qr,
    },
  });
  await tx.zatcaDevice.update({
    where: { id: device.id },
    data: { icv: input.icv, lastHash: stamped.invoiceHash },
  });
  return { ...stamped, uuid: input.uuid };
}

async function orderLines(tx: Tx, ctx: TenantContext, orderId: string) {
  const order = await tx.posOrder.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: orderId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      payments: true,
      register: { include: { branch: { select: { timeZone: true } } } },
    },
  });
  const codes = new Map(
    (
      await tx.taxCode.findMany({
        where: { organizationId: ctx.organizationId },
        select: { id: true, category: true },
      })
    ).map((c) => [c.id, c.category]),
  );
  return { order, codes };
}

const categoryOf = (codes: Map<string, string>, id: string | null) =>
  (id && CATEGORY[codes.get(id) ?? ""]) || "S";

/** The simplified tax invoice of a paid order (called in the order's transaction). */
export async function issueOrderInvoiceInTx(tx: Tx, ctx: TenantContext, orderId: string) {
  const { order, codes } = await orderLines(tx, ctx, orderId);
  if (order.lines.every((l) => l.taxRate === null)) return null; // VAT not registered
  return issueInTx(tx, ctx, {
    registerId: order.registerId,
    type: "INVOICE",
    orderId: order.id,
    number: order.number,
    issuedAt: order.orderedAt,
    timeZone: order.register.branch.timeZone ?? ctx.timeZone,
    // UNTDID 4461: 48 bank card, 10 cash, 1 not defined (only gift cards, or nothing to pay).
    paymentMeans: order.payments.some((p) => p.method === "CARD")
      ? "48"
      : order.payments.some((p) => p.method === "CASH")
        ? "10"
        : "1",
    lines: order.lines.map((l) => ({
      name: l.name,
      quantity: dec(l.quantity),
      net: dec(l.netAmount),
      vat: dec(l.taxAmount),
      category: categoryOf(codes, l.taxCodeId),
      percent: dec(l.taxRate ?? 0).times(100),
    })),
  });
}

/**
 * A credit note for a refund, or for a whole voided order (a reported
 * invoice is never deleted; it is corrected by a credit note).
 */
export async function issueCreditNoteInTx(
  tx: Tx,
  ctx: TenantContext,
  a: {
    orderId: string;
    refundId?: string;
    reason: string;
    registerId?: string;
    method?: "CASH" | "CARD";
  },
) {
  const invoice = await tx.zatcaDocument.findFirst({
    where: { organizationId: ctx.organizationId, orderId: a.orderId, type: "INVOICE" },
    select: { id: true },
  });
  if (!invoice) return null; // the sale was not e-invoiced (before onboarding)
  const { order, codes } = await orderLines(tx, ctx, a.orderId);
  let lines: ZatcaLine[];
  let number = `${order.number}-V`;
  if (a.refundId) {
    const refund = await tx.posRefund.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: a.refundId },
    });
    number = refund.number;
    lines = (
      refund.lines as Array<{ orderLineId: string; quantity: string; gross: string; tax: string }>
    ).map((x) => {
      const l = order.lines.find((o) => o.id === x.orderLineId)!;
      return {
        name: l.name,
        quantity: dec(x.quantity),
        net: dec(x.gross).minus(dec(x.tax)),
        vat: dec(x.tax),
        category: categoryOf(codes, l.taxCodeId),
        percent: dec(l.taxRate ?? 0).times(100),
      };
    });
  } else {
    lines = order.lines.map((l) => ({
      name: l.name,
      quantity: dec(l.quantity),
      net: dec(l.netAmount),
      vat: dec(l.taxAmount),
      category: categoryOf(codes, l.taxCodeId),
      percent: dec(l.taxRate ?? 0).times(100),
    }));
  }
  return issueInTx(tx, ctx, {
    registerId: a.registerId ?? order.registerId,
    type: "CREDIT_NOTE",
    orderId: a.refundId ? undefined : order.id,
    refundId: a.refundId,
    number,
    issuedAt: new Date(),
    timeZone: order.register.branch.timeZone ?? ctx.timeZone,
    // A refund names its method; a void returns money the way the order was paid.
    paymentMeans: a.method
      ? a.method === "CARD"
        ? "48"
        : "10"
      : order.payments.some((p) => p.method === "CARD")
        ? "48"
        : order.payments.some((p) => p.method === "CASH")
          ? "10"
          : "1",
    lines,
    billingReference: order.number,
    reason: a.reason,
  });
}

/** The QR for an order's receipt: the signed document's, else Phase 1 (VAT registered in Saudi Arabia). */
export async function receiptQrInTx(tx: Tx, ctx: TenantContext, orderId: string) {
  const doc = await tx.zatcaDocument.findFirst({
    where: { organizationId: ctx.organizationId, orderId, type: "INVOICE" },
    select: { qr: true },
  });
  if (doc) return { qr: doc.qr, signed: true };
  const party = await seller(tx, ctx);
  const tax = await tx.taxSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  if (!tax?.vatRegistered || !tax.vatNumber || tax.country !== "SA") return null;
  const order = await tx.posOrder.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: orderId },
    include: { register: { include: { branch: { select: { timeZone: true } } } } },
  });
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: { name: true },
  });
  const { date, time } = localDateTime(
    order.orderedAt,
    order.register.branch.timeZone ?? ctx.timeZone,
  );
  return {
    qr: phase1Qr({
      sellerName: party?.name ?? org.name,
      vatNumber: tax.vatNumber.replace(/\s/g, ""),
      timestamp: `${date}T${time}`,
      total: dec(order.grossAmount).toFixed(2),
      vat: dec(order.taxAmount).toFixed(2),
    }),
    signed: false,
  };
}

// ─── Reporting ───

/**
 * Report due documents of every organization, oldest first per unit (a
 * scheduled job, scripts/report-zatca.ts). Rejected documents keep ZATCA's
 * answer for review; failures without an answer are retried with backoff.
 */
export async function reportDueDocuments(
  options: {
    limit?: number;
    fetchImpl?: Fetch;
    organizationId?: string;
    documentIds?: string[];
    /** Send now, even if a retry is scheduled later ("Clear now"). */
    ignoreBackoff?: boolean;
  } = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const due = await withSystemTx((tx) =>
    tx.zatcaDocument.findMany({
      where: {
        status: "PENDING",
        ...(options.ignoreBackoff ? {} : { nextAttemptAt: { lte: new Date() } }),
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
        ...(options.documentIds ? { id: { in: options.documentIds } } : {}),
      },
      include: { device: true },
      orderBy: [{ deviceId: "asc" }, { icv: "asc" }],
      take: options.limit ?? 100,
    }),
  );
  const results: Array<{ id: string; status: string }> = [];
  for (const d of due) {
    if (d.kind === "STANDARD") {
      results.push(await clearOne(d, fetchImpl));
      continue;
    }
    const r = await reportDocument(
      fetchImpl,
      d.device.environment as ZatcaEnv,
      {
        token: d.device.productionToken!,
        secret: decryptSecret(d.device.productionSecret!, key()),
      },
      {
        invoiceHash: d.invoiceHash,
        uuid: d.uuid,
        invoice: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${d.xml}`).toString("base64"),
      },
    );
    const attempts = d.attempts + 1;
    const delay = retryDelaySeconds(attempts) ?? 3600;
    await withSystemTx((tx) =>
      tx.zatcaDocument.update({
        where: { id: d.id },
        data:
          r.outcome === "RETRY"
            ? {
                attempts,
                nextAttemptAt: new Date(Date.now() + delay * 1000),
                response: (r.body ?? undefined) as object,
              }
            : {
                attempts,
                status: r.outcome,
                response: (r.body ?? undefined) as object,
                reportedAt: r.outcome === "REJECTED" ? null : new Date(),
              },
      }),
    );
    results.push({ id: d.id, status: r.outcome === "RETRY" ? "PENDING" : r.outcome });
  }
  return results;
}

type DueDocument = Awaited<ReturnType<Tx["zatcaDocument"]["findMany"]>>[number] & {
  device: { environment: string; productionToken: string | null; productionSecret: string | null };
};

/** Clear one standard document; ZATCA's cleared document becomes the legal one (ADR-072). */
async function clearOne(d: DueDocument, fetchImpl: Fetch) {
  const r = await clearDocument(
    fetchImpl,
    d.device.environment as ZatcaEnv,
    { token: d.device.productionToken!, secret: decryptSecret(d.device.productionSecret!, key()) },
    {
      invoiceHash: d.invoiceHash,
      uuid: d.uuid,
      invoice: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${d.xml}`).toString("base64"),
    },
  );
  const attempts = d.attempts + 1;
  const delay = retryDelaySeconds(attempts) ?? 3600;
  await withSystemTx((tx) =>
    tx.zatcaDocument.update({
      where: { id: d.id },
      data:
        r.outcome === "RETRY"
          ? {
              attempts,
              nextAttemptAt: new Date(Date.now() + delay * 1000),
              response: (r.body ?? undefined) as object,
            }
          : r.outcome === "REJECTED"
            ? { attempts, status: "REJECTED", response: (r.body ?? undefined) as object }
            : {
                attempts,
                status: r.outcome,
                response: (r.body ?? undefined) as object,
                reportedAt: new Date(),
                clearedXml: r.clearedInvoice,
                qr: qrOf(r.clearedInvoice ?? "") ?? d.qr,
              },
    }),
  );
  return { id: d.id, status: r.outcome === "RETRY" ? "PENDING" : r.outcome };
}

// ─── Standard (B2B) invoices (ADR-072) ───

async function salesInvoiceDocInputs(tx: Tx, ctx: TenantContext, salesInvoiceId: string) {
  const inv = await tx.salesInvoice.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: salesInvoiceId },
    include: {
      customer: true,
      lines: { orderBy: { lineNo: "asc" } },
      delivery: { select: { deliveredAt: true } },
    },
  });
  const codes = new Map(
    (
      await tx.taxCode.findMany({
        where: { organizationId: ctx.organizationId },
        select: { id: true, category: true },
      })
    ).map((c) => [c.id, c.category]),
  );
  const c = inv.customer;
  const buyer: ZatcaBuyer = {
    name: c.name,
    vatNumber: c.taxId?.replace(/\s/g, "") || null,
    otherId: c.crNumber ? { scheme: "CRN", id: c.crNumber } : null,
    street: c.street ?? "",
    building: c.buildingNumber,
    district: c.district,
    city: c.city ?? "",
    postalCode: c.postalCode,
    country: c.countryCode,
  };
  const lines: ZatcaLine[] = inv.lines.map((l) => ({
    name: l.description,
    quantity: dec(l.quantity),
    net: dec(l.netAmount),
    vat: dec(l.taxAmount),
    category: categoryOf(codes, l.taxCodeId),
    percent: dec(l.taxRate ?? 0).times(100),
  }));
  return { inv, buyer, lines };
}

/** Whether a standard invoice must be issued: the back office's unit is onboarded. */
async function officeUnitActive(tx: Tx, ctx: TenantContext) {
  return (
    (await tx.zatcaDevice.count({
      where: { organizationId: ctx.organizationId, purpose: "OFFICE", status: "ACTIVE" },
    })) > 0
  );
}

/**
 * The standard tax invoice of a B2B sales invoice, in the invoice's
 * transaction. Refused — so nothing is invoiced — when the buyer's details
 * would make ZATCA reject it. It is cleared right after (clearSalesInvoice).
 */
export async function issueSalesInvoiceDocumentInTx(
  tx: Tx,
  ctx: TenantContext,
  salesInvoiceId: string,
) {
  if (!(await officeUnitActive(tx, ctx))) return null;
  const { inv, buyer, lines } = await salesInvoiceDocInputs(tx, ctx, salesInvoiceId);
  if (lines.every((l) => l.vat.isZero() && l.category === "S")) return null;
  const problems = buyerProblems(buyer);
  if (problems.length > 0)
    throw businessRuleViolation(
      "ZATCA_BUYER_INCOMPLETE",
      "The customer's details are incomplete for an e-invoice",
      {
        fields: problems.join(", "),
      },
    );
  const date = inv.invoiceDate.toISOString().slice(0, 10);
  // ZATCA's issue date is the moment of issue: an e-invoiced B2B invoice is dated today.
  if (date !== localDateTime(new Date(), ctx.timeZone).date)
    throw businessRuleViolation(
      "ZATCA_INVOICE_DATE_TODAY",
      "E-invoices are dated the day they are issued",
      { field: "invoiceDate" },
    );
  return issueInTx(tx, ctx, {
    registerId: null,
    kind: "STANDARD",
    type: "INVOICE",
    salesInvoiceId: inv.id,
    number: inv.number,
    issuedAt: new Date(),
    timeZone: ctx.timeZone,
    paymentMeans: "1",
    lines,
    buyer,
    deliveryDate: localDateTime(inv.delivery.deliveredAt, ctx.timeZone).date,
    currency: inv.currency,
    vatInSar: dec(inv.taxAmountBase),
  });
}

/** A cancelled B2B invoice that was e-invoiced is corrected by a standard credit note. */
export async function issueSalesCreditNoteInTx(
  tx: Tx,
  ctx: TenantContext,
  salesInvoiceId: string,
  reason: string,
) {
  const original = await tx.zatcaDocument.findFirst({
    where: {
      organizationId: ctx.organizationId,
      salesInvoiceId,
      type: "INVOICE",
      kind: "STANDARD",
    },
  });
  if (!original) return null;
  const { inv, buyer, lines } = await salesInvoiceDocInputs(tx, ctx, salesInvoiceId);
  return issueInTx(tx, ctx, {
    registerId: null,
    kind: "STANDARD",
    type: "CREDIT_NOTE",
    salesInvoiceId: inv.id,
    number: `${inv.number}-CN`,
    issuedAt: new Date(),
    timeZone: ctx.timeZone,
    paymentMeans: "1",
    lines,
    buyer,
    deliveryDate: inv.invoiceDate.toISOString().slice(0, 10),
    currency: inv.currency,
    vatInSar: dec(inv.taxAmountBase),
    billingReference: inv.number,
    reason,
  });
}

/** Clear a sales invoice's pending documents now (right after invoicing, or "Clear now"). */
export async function clearSalesInvoice(
  ctx: TenantContext,
  salesInvoiceId: string,
  fetchImpl: Fetch = fetch,
) {
  assertPermission(ctx.grants, "b2b.manage");
  const ids = await withTenantTx(ctx.organizationId, (tx) =>
    tx.zatcaDocument.findMany({
      where: { organizationId: ctx.organizationId, salesInvoiceId, status: "PENDING" },
      select: { id: true },
      orderBy: { icv: "asc" },
    }),
  );
  if (ids.length === 0) return [];
  return reportDueDocuments({
    organizationId: ctx.organizationId,
    documentIds: ids.map((d) => d.id),
    fetchImpl,
    ignoreBackoff: true,
  });
}

/** The e-invoice state of a sales invoice, for its page. */
export async function salesInvoiceEInvoice(ctx: TenantContext, salesInvoiceId: string) {
  assertPermission(ctx.grants, "b2b.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.zatcaDocument.findMany({
      where: { organizationId: ctx.organizationId, salesInvoiceId },
      select: {
        id: true,
        type: true,
        number: true,
        status: true,
        qr: true,
        response: true,
        reportedAt: true,
        attempts: true,
      },
      orderBy: { icv: "asc" },
    }),
  );
}

/** "Report now" for one organization (the scheduled job reports all). */
export async function reportNow(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return reportDueDocuments({ organizationId: ctx.organizationId, limit: 200 });
}
