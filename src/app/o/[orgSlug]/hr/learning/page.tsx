import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { canViewTraining, complianceMatrix } from "@/modules/learning/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { COMPLIANCE_TONE } from "./status";

/** Who holds the training their job requires (ADR-125). */
export default async function LearningPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/hr/learning">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canViewTraining(ctx)) notFound();
  const branchId = typeof sp.branch === "string" && isUuid(sp.branch) ? sp.branch : undefined;
  const status = sp.status === "LAPSED" || sp.status === "EXPIRING" ? sp.status : null;
  const [t, locale, m] = await Promise.all([
    getTranslations("learning"),
    getLocale(),
    complianceMatrix(ctx, { branchId }),
  ]);
  const base = `/o/${orgSlug}/hr/learning`;
  const keep = (c: { status: string }) =>
    !status ||
    (status === "LAPSED"
      ? c.status === "EXPIRED" || c.status === "OVERDUE"
      : c.status === "EXPIRING");
  const rows = m.rows.filter((r) => r.cells.some(keep));
  const name = (c: { name: string; nameAr: string | null }) =>
    (locale === "ar" && c.nameAr) || c.name;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("hint")}
        actions={
          <div className="flex gap-2">
            <LinkButton href={`${base}/courses`} variant="secondary">
              {t("courses")}
            </LinkButton>
            <LinkButton href={`${base}/sessions`} variant="secondary">
              {t("sessions")}
            </LinkButton>
          </div>
        }
      />
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="training-summary">
          <Card>
            <p className="text-muted text-xs">{t("compliantShare")}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">
              {m.compliantShare === null ? "—" : `${Math.round(m.compliantShare * 100)}%`}
            </p>
          </Card>
          {(["EXPIRING", "EXPIRED", "OVERDUE", "DUE"] as const).map((k) => (
            <Card key={k}>
              <p className="text-muted text-xs">{t(`statuses.${k}`)}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{m.counts[k]}</p>
            </Card>
          ))}
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("branch")}</span>
            <select name="branch" defaultValue={branchId ?? ""} className={`${inputClass} sm:w-56`}>
              <option value="">{t("allBranches")}</option>
              {m.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("show")}</span>
            <select name="status" defaultValue={status ?? ""} className={`${inputClass} sm:w-56`}>
              <option value="">{t("everyone")}</option>
              <option value="LAPSED">{t("lapsed")}</option>
              <option value="EXPIRING">{t("statuses.EXPIRING")}</option>
            </select>
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("apply")}
          </button>
          <a
            href={`${base}/export${branchId ? `?branch=${branchId}` : ""}`}
            className={buttonClass("secondary")}
          >
            {t("export")}
          </a>
        </form>
        {m.courses.length === 0 ? (
          <EmptyState title={t("noRequirements")} hint={t("noRequirementsHint")} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("nobody")} />
        ) : (
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("employee")}</Th>
                {m.courses.map((c) => (
                  <Th key={c.id}>
                    <span className="ltr-value font-mono text-xs">{c.code}</span>
                    <span className="block text-xs font-normal">{name(c)}</span>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee.id} data-testid={`training-${r.employee.number}`}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/hr/employees/${r.employee.id}`}
                      className="hover:underline"
                    >
                      {r.employee.firstName} {r.employee.lastName}
                    </Link>
                    <span className="text-muted block text-xs">
                      {r.employee.branch.code} · {r.employee.jobTitle}
                    </span>
                  </Td>
                  {m.courses.map((c) => {
                    const cell = r.cells.find((x) => x.courseId === c.id);
                    return (
                      <Td key={c.id}>
                        {cell ? (
                          <>
                            <Badge tone={COMPLIANCE_TONE[cell.status]}>
                              {t(`statuses.${cell.status}`)}
                            </Badge>
                            <span className="ltr-value text-muted block text-xs">
                              {cell.expiresOn ?? cell.dueOn ?? ""}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
