import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
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
import { employeeFormOptions, getEmployee } from "@/modules/hr/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  addDocumentAction,
  changeStatusAction,
  removeDocumentAction,
  updateEmployeeAction,
} from "../../actions";
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
  const [t, e] = await Promise.all([getTranslations(), getEmployee(ctx, employeeId)]);
  const options =
    e.can.manage && e.status !== "TERMINATED" ? await employeeFormOptions(ctx, e.id) : null;
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
      </div>
    </>
  );
}
