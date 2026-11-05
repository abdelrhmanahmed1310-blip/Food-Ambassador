import { getLocale, getTranslations } from "next-intl/server";
import { Decimal } from "@/lib/decimal";
import { letterheadInTx } from "@/modules/documents/service";
import { getPayslip } from "@/modules/payroll/service";
import { withTenantTx } from "@/server/db/transactions";
import { renderPdf, pdfResponse } from "@/server/pdf/document";
import { pdfFormat } from "@/server/pdf/format";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** A payslip (ADR-123), for payroll staff or the employee themself once approved. */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/hr/payroll/payslips/[lineId]/pdf">,
) {
  const { orgSlug, lineId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const { line, adjustments, period, final } = await getPayslip(ctx, lineId);
    const seller = await withTenantTx(ctx.organizationId, (tx) =>
      letterheadInTx(tx, ctx, line.run.company.id),
    );
    const [t, locale, f] = await Promise.all([
      getTranslations("payroll"),
      getLocale(),
      pdfFormat(),
    ]);
    const cur = line.run.currency;
    const m = (v: { toString(): string }) => f.money(v, cur);
    const neg = (v: { toString(): string }) => `−${m(v)}`;
    const e = line.employee;
    const name = (locale === "ar" && e.nameAr) || `${e.firstName} ${e.lastName}`;
    const rows: string[][] = [
      ...line.details.components.map((c) => [
        c.code === "BASIC" ? t("basic") : c.name,
        m(c.amount),
      ]),
      ...adjustments
        .filter((a) => a.kind === "ADDITION")
        .map((a) => [
          `${t(`categories.${a.category}`)}${a.note ? ` — ${a.note}` : ""}`,
          m(a.amount),
        ]),
      ...(new Decimal(line.unpaidLeaveDeduction.toString()).gt(0)
        ? [
            [
              t("unpaidLeaveLine", { days: line.unpaidLeaveDays.toString() }),
              neg(line.unpaidLeaveDeduction),
            ],
          ]
        : []),
      ...line.details.contributions
        .filter((c) => new Decimal(c.employee).gt(0))
        .map((c) => [c.name, neg(c.employee)]),
      ...(new Decimal(line.incomeTax.toString()).gt(0)
        ? [[t("incomeTax"), neg(line.incomeTax)]]
        : []),
      ...adjustments
        .filter((a) => a.kind === "DEDUCTION")
        .map((a) => [
          `${t(`categories.${a.category}`)}${a.note ? ` — ${a.note}` : ""}`,
          neg(a.amount),
        ]),
    ];
    const pdf = await renderPdf({
      title: final ? t("payslip") : t("payslipDraft"),
      number: `${line.run.number} · ${e.number}`,
      seller: { name: seller.legalName, lines: seller.address, facts: [] },
      party: { label: t("employee"), name, lines: [e.jobTitle], facts: [[t("number"), e.number]] },
      details: [
        [t("period"), period],
        [t("paidDays"), `${line.paidDays} / ${line.basisDays}`],
        [t("payMethod"), t(`methods.${line.payMethod}`)],
        ...(line.payMethod === "BANK" && e.bankAccount
          ? ([[t("bankName"), `${e.bankAccount.bankName} …${e.bankAccount.ibanLast4}`]] as Array<
              [string, string]
            >)
          : []),
        ...(line.run.paidOn
          ? ([[t("paidOn"), line.run.paidOn.toISOString().slice(0, 10)]] as Array<[string, string]>)
          : []),
      ],
      columns: [
        { label: t("item"), width: 0.7 },
        { label: t("amount"), width: 0.3, align: "right" },
      ],
      rows,
      totals: [
        [t("gross"), m(line.gross)],
        [t("deductions"), neg(new Decimal(line.gross.toString()).minus(line.net.toString()))],
        [t("net"), m(line.net)],
      ],
      notes: [t("employerNote", { amount: m(line.employerContributions) })],
    });
    return pdfResponse(request, pdf, `payslip-${line.run.number}-${e.number}.pdf`);
  } catch (error) {
    return errorResponse(error);
  }
}
