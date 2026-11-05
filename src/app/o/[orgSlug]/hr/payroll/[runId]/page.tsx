import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import {
  AdjustmentForm,
  CancelRunForm,
  PaidForm,
  SettlementForm,
} from "@/components/payroll/forms";
import {
  Alert,
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { businessDate } from "@/modules/inventory/rules";
import { canViewPayroll, getPayrollRun } from "@/modules/payroll/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyIn } from "@/server/fx-view";
import {
  addAdjustmentAction,
  approveRunAction,
  cancelRunAction,
  markPaidAction,
  recalculateAction,
  removeAdjustmentAction,
  settleAction,
} from "../actions";
import { STATUS_TONE } from "../status";

export default async function PayrollRunPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/payroll/[runId]">) {
  const { orgSlug, runId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewPayroll(ctx) || !isUuid(runId)) notFound();
  const [t, r] = await Promise.all([getTranslations("payroll"), getPayrollRun(ctx, runId)]);
  const money = (await moneyIn([r.run.currency]))(r.run.currency).money;
  const base = `/o/${orgSlug}/hr/payroll`;
  const draft = r.run.status === "DRAFT";
  // Employees who leave in this month can be settled (ADR-124).
  const leavers = r.lines.filter(
    (l) =>
      l.employee.terminatedOn && l.employee.terminatedOn.toISOString().slice(0, 7) === r.run.period,
  );
  const nameOf = new Map(
    r.lines.map((l) => [
      l.employeeId,
      `${l.employee.number} — ${l.employee.firstName} ${l.employee.lastName}`,
    ]),
  );
  return (
    <>
      <PageHeader
        title={r.run.number}
        description={`${r.run.company.code} — ${r.run.company.name} · ${r.run.period}`}
        actions={<Badge tone={STATUS_TONE[r.run.status]}>{t(`statuses.${r.run.status}`)}</Badge>}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("gross"), value: <span className="ltr-value">{money(r.run.gross)}</span> },
              {
                label: t("deductions"),
                value: <span className="ltr-value">{money(r.run.deductions)}</span>,
              },
              {
                label: t("net"),
                value: (
                  <span className="ltr-value font-semibold" data-testid="run-net">
                    {money(r.run.net)}
                  </span>
                ),
              },
              {
                label: t("employerContributions"),
                value: <span className="ltr-value">{money(r.run.employerContributions)}</span>,
              },
              {
                label: t("employerCost"),
                value: <span className="ltr-value">{money(r.run.employerCost)}</span>,
              },
              { label: t("prorationBasis"), value: t(`bases.${r.run.prorationBasis}`) },
            ]}
          />
        </Card>
        {r.skipped.length > 0 ? (
          <Alert tone="info">
            {t("skippedList", { employees: r.skipped.map((s) => s.number).join(", ") })}
          </Alert>
        ) : null}
        <Table label={t("lines")}>
          <thead>
            <tr>
              <Th>{t("employee")}</Th>
              <Th>{t("paidDays")}</Th>
              <Th>{t("fixedPay")}</Th>
              <Th>{t("additions")}</Th>
              <Th>{t("unpaidLeave")}</Th>
              <Th>{t("contributionsEmployee")}</Th>
              <Th>{t("incomeTax")}</Th>
              <Th>{t("otherDeductions")}</Th>
              <Th>{t("net")}</Th>
              <Th>{t("employerCost")}</Th>
              <Th>{t("payslip")}</Th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.id} data-testid={`line-${l.employee.number}`}>
                <Td>
                  <Link
                    href={`/o/${orgSlug}/hr/employees/${l.employeeId}`}
                    className="hover:underline"
                  >
                    {l.employee.firstName} {l.employee.lastName}
                  </Link>
                  <span className="ltr-value text-muted block font-mono text-xs">
                    {l.employee.number} · {t(`methods.${l.payMethod}`)}
                  </span>
                </Td>
                <Td className="tabular-nums">
                  {l.paidDays}/{l.basisDays}
                  {l.unpaidLeaveDays.gt(0) ? (
                    <span className="text-muted block text-xs">
                      {t("unpaidDays", { days: l.unpaidLeaveDays.toString() })}
                    </span>
                  ) : null}
                </Td>
                <Td className="ltr-value tabular-nums">{money(l.fixedPay)}</Td>
                <Td className="ltr-value tabular-nums">{money(l.additions)}</Td>
                <Td className="ltr-value tabular-nums">{money(l.unpaidLeaveDeduction)}</Td>
                <Td className="ltr-value tabular-nums">
                  {money(l.employeeContributions)}
                  {l.details.contributions.map((c) => (
                    <span key={c.ruleId} className="text-muted block text-xs">
                      {c.code}: {c.employee} / {c.employer}
                    </span>
                  ))}
                </Td>
                <Td className="ltr-value tabular-nums">
                  {money(l.incomeTax)}
                  {l.details.tax ? (
                    <span className="text-muted block text-xs">{l.details.tax.code}</span>
                  ) : null}
                </Td>
                <Td className="ltr-value tabular-nums">{money(l.otherDeductions)}</Td>
                <Td className="ltr-value font-medium tabular-nums">{money(l.net)}</Td>
                <Td className="ltr-value tabular-nums">
                  {money(l.employerCost)}
                  {l.details.eos ? (
                    <span className="text-muted block text-xs">
                      {t("eosShort", { amount: money(l.eosAccrual) })}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <a
                    href={`${base}/payslips/${l.id}/pdf?inline=1`}
                    className="text-primary text-sm hover:underline"
                  >
                    PDF
                  </a>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>

        {r.adjustments.length > 0 ? (
          <Card title={t("adjustments")}>
            <ul className="divide-border divide-y text-sm">
              {r.adjustments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {nameOf.get(a.employeeId)} · {t(`categories.${a.category}`)} ·{" "}
                    <span className="ltr-value">
                      {a.kind === "DEDUCTION" ? "−" : "+"}
                      {money(a.amount)}
                    </span>
                    {a.note ? <span className="text-muted"> — {a.note}</span> : null}
                  </span>
                  {draft && r.canManage ? (
                    <ConfirmActionButton
                      action={removeAdjustmentAction.bind(null, orgSlug, a.id)}
                      label={t("remove")}
                      variant="secondary"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {draft && r.canManage && leavers.length > 0 ? (
          <Card title={t("settleTitle")}>
            <SettlementForm
              action={settleAction.bind(null, orgSlug, r.run.id)}
              employees={leavers.map((l) => ({
                value: l.employeeId,
                label: nameOf.get(l.employeeId)!,
              }))}
            />
          </Card>
        ) : null}
        {draft && r.canManage ? (
          <Card title={t("addAdjustment")}>
            <AdjustmentForm
              action={addAdjustmentAction.bind(null, orgSlug, r.run.id)}
              employees={r.lines.map((l) => ({
                value: l.employeeId,
                label: nameOf.get(l.employeeId)!,
              }))}
            />
          </Card>
        ) : null}

        <div className="flex flex-wrap items-start gap-3">
          {draft && r.canManage ? (
            <ConfirmActionButton
              action={recalculateAction.bind(null, orgSlug, r.run.id)}
              label={t("recalculate")}
              variant="secondary"
            />
          ) : null}
          {draft && r.canApprove ? (
            <ConfirmActionButton
              action={approveRunAction.bind(null, orgSlug, r.run.id)}
              label={t("approve")}
              confirmMessage={t("approveConfirm")}
              variant="primary"
            />
          ) : null}
          {draft && !r.canApprove ? (
            <p className="text-muted text-sm">{t("approverNote")}</p>
          ) : null}
          {(r.run.status === "APPROVED" || r.run.status === "PAID") && r.canManage ? (
            <a href={`${base}/${r.run.id}/bank-file`} className={buttonClass("secondary")}>
              {t("bankFile")}
            </a>
          ) : null}
        </div>
        {r.run.status === "APPROVED" && r.canManage ? (
          <Card title={t("markPaid")}>
            <PaidForm
              action={markPaidAction.bind(null, orgSlug, r.run.id)}
              today={businessDate(ctx.timeZone)}
            />
          </Card>
        ) : null}
        {(draft || r.run.status === "APPROVED") && r.canManage ? (
          <Card title={t("cancelRun")}>
            <CancelRunForm action={cancelRunAction.bind(null, orgSlug, r.run.id)} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
