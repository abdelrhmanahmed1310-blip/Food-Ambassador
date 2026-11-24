import "server-only";
import { Decimal } from "@/lib/decimal";
import { hasPermission } from "@/modules/access/authorize";
import { uninvoicedReceiptLines } from "@/modules/invoices/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import type { NewProposal } from "./replenishment";
import { creditRequest, type Finding, type InvoiceMatchingSettings } from "./rules";

/**
 * The invoice matching agent (DECISIONS.md ADR-142): for draft supplier
 * invoices that fail the 3-way match (ADR-038) and wait for approval, it
 * says what does not match and works out what the supplier billed beyond the
 * order and the receipt. Above the set minimum it proposes accepting the
 * invoice and asking the supplier for a credit note of that amount — the
 * approver's own exception approval, under the usual rule that the person
 * who entered the invoice may not approve it. It also reports printed totals
 * that do not add up (no credit request until they do) and received goods
 * not invoiced after a number of days.
 * Nothing is sent to a supplier.
 */

const dec = (v: { toString(): string } | null | undefined) =>
  v === null || v === undefined ? null : new Decimal(v.toString());

export function canRunInvoiceMatching(ctx: TenantContext) {
  return hasPermission(ctx.grants, "invoices.manage");
}

export async function runInvoiceMatching(
  ctx: TenantContext,
  settings: InvoiceMatchingSettings,
  count: () => void,
) {
  const org = ctx.organizationId;
  const minimum = new Decimal(settings.minCreditAmount);
  const invoices = await withTenantTx(org, (tx) =>
    tx.supplierInvoice.findMany({
      where: {
        organizationId: org,
        status: "DRAFT",
        matchStatus: "EXCEPTION",
        exceptionApprovedAt: null,
      },
      select: {
        id: true,
        number: true,
        supplierInvoiceNo: true,
        invoiceDate: true,
        currency: true,
        printedGross: true,
        grossAmount: true,
        supplier: { select: { code: true, name: true } },
        lines: {
          where: { kind: "GOODS" },
          orderBy: { lineNo: "asc" },
          select: {
            lineNo: true,
            match: true,
            quantity: true,
            quantityBase: true,
            unitPrice: true,
            orderedUnitPrice: true,
            quantityVariance: true,
            priceVariance: true,
            product: { select: { sku: true } },
          },
        },
      },
      orderBy: { invoiceDate: "asc" },
      take: 200,
    }),
  );
  count();
  const findings: Finding[] = [];
  const proposals: NewProposal[] = [];
  for (const inv of invoices) {
    const base = {
      number: inv.number,
      supplier: inv.supplier.code,
      currency: inv.currency,
    };
    const printed = new Decimal(inv.printedGross.toString());
    const computed = new Decimal(inv.grossAmount.toString());
    const totalOk = printed.toDecimalPlaces(2).equals(computed.toDecimalPlaces(2));
    if (!totalOk)
      findings.push({
        severity: "WARNING",
        code: "INVOICE_TOTAL_MISMATCH",
        params: { ...base, printed: printed.toFixed(2), computed: computed.toFixed(2) },
        link: `purchasing/invoices/${inv.id}`,
      });
    const lines = inv.lines
      .filter((l) => l.match !== "MATCHED" && l.match !== "NOT_APPLICABLE")
      .map((l) => ({
        lineNo: l.lineNo,
        sku: l.product?.sku ?? null,
        match: l.match,
        quantity: new Decimal(l.quantity.toString()),
        quantityBase: dec(l.quantityBase),
        unitPrice: new Decimal(l.unitPrice.toString()),
        orderedUnitPrice: dec(l.orderedUnitPrice),
        quantityVariance: dec(l.quantityVariance),
        priceVariance: dec(l.priceVariance),
      }));
    if (lines.length === 0) continue;
    const credit = creditRequest(lines);
    findings.push({
      severity: "WARNING",
      code: "INVOICE_EXCEPTION",
      params: { ...base, lines: lines.length, amount: credit.total.toFixed(2) },
      link: `purchasing/invoices/${inv.id}`,
    });
    // A printed total that does not add up is usually a keying error: it is fixed
    // first, never accepted along with a credit request.
    if (totalOk && credit.total.gt(0) && credit.total.gte(minimum))
      proposals.push({
        kind: "CREDIT_REQUEST",
        title: `${inv.number} · ${inv.supplier.name}`,
        detail: {
          invoiceNumber: inv.number,
          supplierInvoiceNo: inv.supplierInvoiceNo,
          supplier: inv.supplier.name,
          supplierCode: inv.supplier.code,
          currency: inv.currency,
          total: credit.total.toFixed(2),
          lines: credit.lines.map((l) => {
            const src = lines.find((x) => x.lineNo === l.lineNo)!;
            return {
              lineNo: l.lineNo,
              sku: l.sku,
              reason: l.reason,
              amount: l.amount.toFixed(2),
              invoicedPrice: src.unitPrice.toFixed(),
              orderedPrice: src.orderedUnitPrice?.toFixed() ?? null,
            };
          }),
        },
        entityType: "supplier_invoice",
        entityId: inv.id,
      });
  }

  // Received goods not invoiced after the set number of days, per supplier.
  const cutoff = new Date(
    `${addDays(businessDate(ctx.timeZone), -settings.uninvoicedAfterDays)}T00:00:00Z`,
  );
  const canSeeReceipts = hasPermission(ctx.grants, "invoices.view");
  const suppliers = !canSeeReceipts
    ? []
    : await withTenantTx(org, (tx) =>
        tx.supplier.findMany({
          where: {
            organizationId: org,
            receipts: { some: { status: "POSTED", receivedAt: { lt: cutoff } } },
          },
          select: { id: true, code: true },
          orderBy: { code: "asc" },
          take: 100,
        }),
      );
  count();
  for (const s of suppliers) {
    const open = (await uninvoicedReceiptLines(ctx, s.id)).filter(
      (l) => l.receipt.receivedAt < cutoff,
    );
    count();
    if (open.length === 0) continue;
    findings.push({
      severity: "INFO",
      code: "UNINVOICED_RECEIPTS",
      params: {
        supplier: s.code,
        receipts: new Set(open.map((l) => l.receipt.number)).size,
        days: settings.uninvoicedAfterDays,
      },
      link: "purchasing/invoices",
    });
  }
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    summary: {
      exceptions: invoices.length,
      proposals: proposals.length,
    },
    findings,
    proposals,
  };
}
