import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Pagination } from "@/components/ui/pagination";
import {
  Badge,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { canViewHr, EMPLOYEE_STATUSES, listDepartments, listEmployees } from "@/modules/hr/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const TONE = { ACTIVE: "success", ON_LEAVE: "warning", TERMINATED: "muted" } as const;

export default async function EmployeesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/hr/employees">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const [t, list, departments] = await Promise.all([
    getTranslations(),
    listEmployees(ctx, {
      q: one(sp.q),
      status: one(sp.status),
      departmentId: one(sp.departmentId),
      page: Number(one(sp.page)) || 1,
    }),
    listDepartments(ctx),
  ]);
  const base = `/o/${orgSlug}/hr`;
  return (
    <>
      <PageHeader
        title={t("hr.employees")}
        actions={
          holdsAnyGrant(ctx.grants, "hr.manage") ? (
            <LinkButton href={`${base}/employees/new`}>{t("hr.newEmployee")}</LinkButton>
          ) : null
        }
      />
      <form method="get" role="search" className="mb-4 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="q" className="sr-only">
          {t("common.search")}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={one(sp.q)}
          placeholder={t("hr.searchPlaceholder")}
          className={`${inputClass} sm:flex-1`}
        />
        <label htmlFor="status" className="sr-only">
          {t("hr.status")}
        </label>
        <select
          id="status"
          name="status"
          defaultValue={one(sp.status)}
          className={`${inputClass} sm:w-44`}
        >
          <option value="">{t("hr.currentStaff")}</option>
          {EMPLOYEE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`hr.statuses.${s}`)}
            </option>
          ))}
        </select>
        <label htmlFor="departmentId" className="sr-only">
          {t("hr.department")}
        </label>
        <select
          id="departmentId"
          name="departmentId"
          defaultValue={one(sp.departmentId)}
          className={`${inputClass} sm:w-48`}
        >
          <option value="">{t("hr.allDepartments")}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass("secondary")}>
          {t("common.apply")}
        </button>
      </form>
      {list.items.length === 0 ? (
        <EmptyState title={t("hr.noEmployees")} />
      ) : (
        <Table label={t("hr.employees")}>
          <thead>
            <tr>
              <Th>{t("hr.name")}</Th>
              <Th>{t("hr.jobTitle")}</Th>
              <Th>{t("hr.branch")}</Th>
              <Th>{t("hr.department")}</Th>
              <Th>{t("hr.manager")}</Th>
              <Th>{t("hr.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((e) => (
              <tr key={e.id} data-testid="employee-row">
                <Td>
                  <Link
                    href={`${base}/employees/${e.id}`}
                    className="text-primary font-medium hover:underline"
                  >
                    {e.firstName} {e.lastName}
                  </Link>
                  <span className="ltr-value text-muted block font-mono text-xs">{e.number}</span>
                </Td>
                <Td>{e.jobTitle}</Td>
                <Td className="ltr-value font-mono text-xs">{e.branch.code}</Td>
                <Td>{e.department?.name ?? "—"}</Td>
                <Td>{e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : "—"}</Td>
                <Td>
                  <Badge tone={TONE[e.status]}>{t(`hr.statuses.${e.status}`)}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={`${base}/employees`}
        params={{ q: one(sp.q), status: one(sp.status), departmentId: one(sp.departmentId) }}
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
      />
    </>
  );
}
