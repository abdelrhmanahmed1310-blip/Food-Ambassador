import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ManualPunchForm, PinForm, VoidPunchForm } from "@/components/hr/attendance-forms";
import { AllocationForm, LeaveRequestForm } from "@/components/hr/leave-forms";
import { LeaveTable } from "@/components/hr/leave-table";
import { DocumentForm, EmployeeForm, StatusForm } from "@/components/hr/forms";
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
import { employeePunches } from "@/modules/hr/attendance";
import { employeeLeave } from "@/modules/hr/leave";
import { employeeFormOptions, getEmployee } from "@/modules/hr/service";
import { businessDate } from "@/modules/inventory/rules";
import { canViewPayroll, employeePay } from "@/modules/payroll/service";
import { canViewTraining, employeeTraining } from "@/modules/learning/service";
import { TrainingSection } from "@/components/learning/training-section";
import { GoalsSection } from "@/components/performance/goals-section";
import { employeeGoals } from "@/modules/performance/service";
import { getLocale } from "next-intl/server";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyIn } from "@/server/fx-view";
import { BankForm, SalaryForm } from "@/components/payroll/forms";
import { setBankAction, setSalaryAction } from "../../payroll/actions";
import {
  addDocumentAction,
  changeStatusAction,
  removeDocumentAction,
  updateEmployeeAction,
} from "../../actions";
import { manualPunchAction, setPinAction, voidPunchAction } from "../../attendance/actions";
import { cancelLeaveAction, requestLeaveAction, setAllocationAction } from "../../leave/actions";
import { optionsFor } from "../options";

const TONE = { ACTIVE: "success", ON_LEAVE: "warning", TERMINATED: "muted" } as const;
const DOC_TONE = {
  EXPIRED: "danger",
  EXPIRING: "warning",
  VALID: "success",
  NO_EXPIRY: "muted",
} as const;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

export default async function EmployeePage({
  params,
}: PageProps<"/o/[orgSlug]/hr/employees/[employeeId]">) {
  const { orgSlug, employeeId } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, e, attendance, leave] = await Promise.all([
    getTranslations(),
    getEmployee(ctx, employeeId),
    employeePunches(ctx, employeeId),
    employeeLeave(ctx, employeeId),
  ]);
  const hm = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: attendance.timeZone,
    }).format(d);
  const hours = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  const options =
    e.can.manage && e.status !== "TERMINATED" ? await employeeFormOptions(ctx, e.id) : null;
  // Pay (ADR-123) is for payroll staff only.
  const pay = canViewPayroll(ctx) ? await employeePay(ctx, e.id) : null;
  // Training (ADR-125) for those who see training at the employee's branch.
  const training = canViewTraining(ctx)
    ? await employeeTraining(ctx, e.id).catch(() => null)
    : null;
  const locale = await getLocale();
  // Goals and reviews (ADR-126): HR, the employee's manager, or the employee.
  const performance = await employeeGoals(ctx, e.id).catch(() => null);
  const money = pay ? (await moneyIn([pay.currency]))(pay.currency).money : null;
  const base = `/o/${orgSlug}/hr`;
  return (
    <>
      <PageHeader
        title={`${e.firstName} ${e.lastName}`}
        description={`${e.number} · ${e.jobTitle} · ${e.branch.code} — ${e.branch.name}`}
      />
      <div className="space-y-6">
        <Card title={t("hr.profile")}>
          <DescriptionList
            items={[
              {
                label: t("hr.status"),
                value: <Badge tone={TONE[e.status]}>{t(`hr.statuses.${e.status}`)}</Badge>,
              },
              { label: t("hr.nameAr"), value: e.nameAr ?? "—" },
              { label: t("hr.department"), value: e.department?.name ?? "—" },
              {
                label: t("hr.manager"),
                value: e.manager ? (
                  <Link
                    href={`${base}/employees/${e.manager.id}`}
                    className="text-primary hover:underline"
                  >
                    {e.manager.firstName} {e.manager.lastName}
                  </Link>
                ) : (
                  "—"
                ),
              },
              { label: t("hr.employmentType"), value: t(`hr.employmentTypes.${e.employmentType}`) },
              {
                label: t("hr.hireDate"),
                value: <span className="ltr-value">{day(e.hireDate)}</span>,
              },
              { label: t("hr.nationality"), value: e.nationality ?? "—" },
              {
                label: t("hr.nationalId"),
                value: e.can.manage ? (e.nationalId ?? "—") : t("hr.hidden"),
              },
              {
                label: t("hr.email"),
                value: e.email ? <span className="ltr-value">{e.email}</span> : "—",
              },
              {
                label: t("hr.phone"),
                value: e.phone ? <span className="ltr-value">{e.phone}</span> : "—",
              },
              {
                label: t("hr.account"),
                value: e.user ? <span className="ltr-value">{e.user.email}</span> : "—",
              },
              ...(e.status === "TERMINATED"
                ? [
                    {
                      label: t("hr.terminatedOn"),
                      value: <span className="ltr-value">{day(e.terminatedOn)}</span>,
                    },
                    { label: t("hr.terminationReason"), value: e.terminationReason ?? "—" },
                  ]
                : []),
            ]}
          />
          {e.reports.length > 0 ? (
            <div className="mt-4">
              <p className="text-muted mb-1 text-xs">{t("hr.directReports")}</p>
              <ul className="flex flex-wrap gap-2 text-sm">
                {e.reports.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`${base}/employees/${r.id}`}
                      className="border-border hover:bg-surface-muted rounded-full border px-3 py-1"
                    >
                      {r.firstName} {r.lastName} · {r.jobTitle}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card title={t("hr.documents")}>
          {e.documents.length === 0 ? (
            <p className="text-muted mb-4 text-sm">{t("hr.noDocuments")}</p>
          ) : (
            <div className="mb-4">
              <Table label={t("hr.documents")}>
                <thead>
                  <tr>
                    <Th>{t("hr.documentType")}</Th>
                    <Th>{t("hr.documentNumber")}</Th>
                    <Th>{t("hr.expiresOn")}</Th>
                    <Th>{t("hr.state")}</Th>
                    {e.can.manage ? <Th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {e.documents.map((d) => (
                    <tr key={d.id} data-testid="employee-document">
                      <Td>{t(`hr.documentTypes.${d.type}`)}</Td>
                      <Td className="ltr-value font-mono text-xs">
                        {e.can.manage ? (d.number ?? "—") : t("hr.hidden")}
                      </Td>
                      <Td className="ltr-value">{day(d.expiresOn) || "—"}</Td>
                      <Td>
                        <Badge tone={DOC_TONE[d.state]}>{t(`hr.documentStates.${d.state}`)}</Badge>
                      </Td>
                      {e.can.manage ? (
                        <Td>
                          <ConfirmActionButton
                            action={removeDocumentAction.bind(null, orgSlug, d.id)}
                            label={t("hr.remove")}
                            confirmMessage={t("hr.removeDocumentConfirm")}
                          />
                        </Td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          {e.can.manage ? (
            <DocumentForm action={addDocumentAction.bind(null, orgSlug, e.id)} />
          ) : null}
        </Card>

        <Card title={t("leave.employeeCard", { year: leave.year })}>
          <div className="space-y-4" data-testid="employee-leave">
            <ul className="grid gap-2 text-sm sm:grid-cols-2">
              {leave.balances
                .filter((b) => b.type.usesBalance)
                .map((b) => (
                  <li
                    key={b.type.id}
                    className="border-border flex justify-between rounded-lg border px-3 py-2"
                  >
                    <span>{b.type.name}</span>
                    <span className="tabular-nums">
                      {b.allocated
                        ? t("leave.remainingOf", {
                            remaining: b.remaining!.toFixed(0),
                            allocated: b.allocated.toFixed(0),
                          })
                        : t("leave.noEntitlement")}
                    </span>
                  </li>
                ))}
            </ul>
            {leave.requests.length > 0 ? (
              <LeaveTable
                rows={leave.requests}
                showEmployee={false}
                actions={(r) =>
                  leave.can.manage && (r.status === "PENDING" || r.status === "APPROVED")
                    ? { cancel: cancelLeaveAction.bind(null, orgSlug, r.id) }
                    : {}
                }
              />
            ) : null}
            {leave.can.manage && e.status !== "TERMINATED" ? (
              <>
                <AllocationForm
                  action={setAllocationAction.bind(null, orgSlug, e.id)}
                  types={leave.balances
                    .filter((b) => b.type.usesBalance)
                    .map((b) => ({ value: b.type.id, label: b.type.name }))}
                  year={leave.year}
                />
                <LeaveRequestForm
                  action={requestLeaveAction.bind(null, orgSlug, e.id)}
                  types={leave.balances.map((b) => ({ value: b.type.id, label: b.type.name }))}
                  submitLabel={t("leave.requestFor")}
                />
              </>
            ) : null}
          </div>
        </Card>

        <Card title={t("attendance.employeeCard")}>
          <div className="space-y-4" data-testid="employee-attendance">
            {attendance.days.length === 0 ? (
              <p className="text-muted text-sm">{t("attendance.noPunches")}</p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {attendance.days.map((d) => (
                  <li
                    key={d.day}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="ltr-value">{d.day}</span>
                    <span className="tabular-nums">{hours(d.minutes)}</span>
                    {d.issues > 0 ? (
                      <Badge tone="danger">{t("attendance.issues", { count: d.issues })}</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {attendance.punches.length > 0 ? (
              <Table label={t("attendance.punches")}>
                <thead>
                  <tr>
                    <Th>{t("attendance.when")}</Th>
                    <Th>{t("attendance.kind")}</Th>
                    <Th>{t("attendance.source")}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {attendance.punches.map((p) => (
                    <tr
                      key={p.id}
                      data-testid="punch-row"
                      className={p.voidedAt ? "opacity-50" : ""}
                    >
                      <Td className="ltr-value">{hm(p.at)}</Td>
                      <Td>{t(`attendance.kinds.${p.kind}`)}</Td>
                      <Td>
                        {t(`attendance.sources.${p.source}`)}
                        {p.terminal
                          ? ` · ${p.terminal.name}`
                          : p.connector
                            ? ` · ${p.connector.name}`
                            : ""}
                        {p.reason ? (
                          <span className="text-muted block text-xs">{p.reason}</span>
                        ) : null}
                        {p.voidReason ? (
                          <span className="text-danger block text-xs">
                            {t("attendance.voided")}: {p.voidReason}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        {attendance.can.manage && !p.voidedAt ? (
                          <VoidPunchForm action={voidPunchAction.bind(null, orgSlug, p.id)} />
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
            {attendance.can.manage && e.status !== "TERMINATED" ? (
              <>
                <ManualPunchForm
                  action={manualPunchAction.bind(null, orgSlug, e.id)}
                  today={businessDate(attendance.timeZone)}
                />
                <div>
                  <p className="text-muted mb-2 text-xs">
                    {attendance.hasPin ? t("attendance.pinIsSet") : t("attendance.noPin")}
                  </p>
                  <PinForm action={setPinAction.bind(null, orgSlug, e.id)} />
                </div>
              </>
            ) : null}
          </div>
        </Card>

        {e.can.manage ? (
          <Card title={t("hr.employmentStatus")}>
            {e.reports.length > 0 && e.status !== "TERMINATED" ? (
              <div className="mb-3">
                <Alert tone="info">{t("hr.reportsFirst")}</Alert>
              </div>
            ) : null}
            <StatusForm action={changeStatusAction.bind(null, orgSlug, e.id)} current={e.status} />
          </Card>
        ) : null}

        {options ? (
          <Card title={t("hr.editEmployee")}>
            <EmployeeForm
              action={updateEmployeeAction.bind(null, orgSlug, e.id)}
              submitLabel={t("common.save")}
              {...optionsFor(options)}
              members={[
                ...(e.user ? [{ value: e.user.id, label: e.user.email }] : []),
                ...optionsFor(options).members,
              ]}
              defaults={{
                number: e.number,
                firstName: e.firstName,
                lastName: e.lastName,
                nameAr: e.nameAr,
                email: e.email,
                phone: e.phone,
                nationality: e.nationality,
                nationalId: e.nationalId,
                jobTitle: e.jobTitle,
                branchId: e.branchId,
                departmentId: e.departmentId,
                managerId: e.managerId,
                employmentType: e.employmentType,
                hireDate: day(e.hireDate),
                userId: e.userId,
              }}
            />
          </Card>
        ) : null}
        {performance ? (
          <Card title={t("performance.goalsAndReviews")}>
            <GoalsSection
              orgSlug={orgSlug}
              employeeId={e.id}
              goals={performance.goals}
              reviews={performance.reviews}
              cycles={performance.cycles}
              canSetGoals={performance.canSetGoals}
              canUpdate={performance.own}
            />
          </Card>
        ) : null}
        {training ? (
          <Card title={t("learning.training")}>
            <TrainingSection
              ctx={ctx}
              data={training}
              locale={locale}
              orgSlug={orgSlug}
              employeeId={e.id}
              manage={training.canManage}
            />
          </Card>
        ) : null}
        {pay && money ? (
          <Card title={t("payroll.pay")}>
            <div className="space-y-4" data-testid="employee-pay">
              {pay.salaries.length === 0 ? (
                <p className="text-muted text-sm">{t("payroll.noSalary")}</p>
              ) : (
                <Table label={t("payroll.pay")}>
                  <thead>
                    <tr>
                      <Th>{t("payroll.effectiveFrom")}</Th>
                      <Th>{t("payroll.basic")}</Th>
                      <Th>{t("payroll.allowances")}</Th>
                      <Th>{t("payroll.monthlyTotal")}</Th>
                      <Th>{t("payroll.payMethod")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {pay.salaries.map((s) => (
                      <tr key={s.id}>
                        <Td className="ltr-value">{s.effectiveFrom}</Td>
                        <Td className="ltr-value tabular-nums">{money(s.basic)}</Td>
                        <Td className="text-sm">
                          {s.items.length === 0
                            ? "—"
                            : s.items.map((i) => (
                                <span key={i.code} className="block">
                                  {i.name}: <span className="ltr-value">{money(i.amount)}</span>
                                  {i.inContributionBase ? " *" : ""}
                                </span>
                              ))}
                        </Td>
                        <Td className="ltr-value font-medium tabular-nums">{money(s.total)}</Td>
                        <Td>{t(`payroll.methods.${s.payMethod}`)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <p className="text-muted text-sm">
                {pay.bank
                  ? t("payroll.bankOnFile", { bank: pay.bank.bankName, last4: pay.bank.ibanLast4 })
                  : t("payroll.noBank")}
              </p>
              {pay.canManage ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">{t("payroll.newSalary")}</h3>
                    <SalaryForm action={setSalaryAction.bind(null, orgSlug, e.id)} />
                  </div>
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">{t("payroll.bankAccount")}</h3>
                    <BankForm action={setBankAction.bind(null, orgSlug, e.id)} />
                  </div>
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
