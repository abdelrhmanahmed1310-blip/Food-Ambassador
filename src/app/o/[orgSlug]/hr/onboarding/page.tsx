import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  Badge,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { accessibleScope } from "@/modules/access/authorize";
import { canViewHr } from "@/modules/hr/service";
import { onboardingBoard } from "@/modules/rosters/onboarding";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** Open onboarding checklists with progress (ADR-128). */
export default async function OnboardingPage({ params }: PageProps<"/o/[orgSlug]/hr/onboarding">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const [t, lists] = await Promise.all([getTranslations("onboarding"), onboardingBoard(ctx)]);
  const base = `/o/${orgSlug}/hr/onboarding`;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("hint")}
        actions={
          accessibleScope(ctx.grants, "hr.manage").all ? (
            <LinkButton href={`${base}/templates`} variant="secondary">
              {t("templates")}
            </LinkButton>
          ) : null
        }
      />
      {lists.length === 0 ? (
        <EmptyState title={t("noneOpen")} hint={t("noneOpenHint")} />
      ) : (
        <Table label={t("title")}>
          <thead>
            <tr>
              <Th>{t("employee")}</Th>
              <Th>{t("checklist")}</Th>
              <Th>{t("startedOn")}</Th>
              <Th>{t("progressLabel")}</Th>
              <Th>{t("nextDue")}</Th>
            </tr>
          </thead>
          <tbody>
            {lists.map((c) => (
              <tr key={c.id}>
                <Td>
                  <Link href={`${base}/${c.id}`} className="font-medium underline">
                    {c.employee.firstName} {c.employee.lastName}
                  </Link>
                  <span className="text-muted block text-xs">
                    {c.employee.number} · {c.employee.branch.code}
                  </span>
                </Td>
                <Td>{c.template.name}</Td>
                <Td className="tabular-nums">{c.startedOn.toISOString().slice(0, 10)}</Td>
                <Td>
                  {t("progress", { done: c.progress.done, total: c.progress.total })}{" "}
                  {c.progress.overdue ? (
                    <Badge tone="danger">{t("overdueCount", { count: c.progress.overdue })}</Badge>
                  ) : null}
                </Td>
                <Td className="tabular-nums">{c.progress.nextDue ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
