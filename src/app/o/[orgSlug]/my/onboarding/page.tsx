import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader } from "@/components/ui/primitives";
import { myOnboarding } from "@/modules/rosters/onboarding";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** Onboarding the signed-in user takes part in: their own, and their reports' (ADR-128). */
export default async function MyOnboardingPage({
  params,
}: PageProps<"/o/[orgSlug]/my/onboarding">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, data] = await Promise.all([getTranslations("onboarding"), myOnboarding(ctx)]);
  return (
    <>
      <PageHeader title={t("myTitle")} description={t("tasksToDo", { count: data.tasksToDo })} />
      {data.checklists.length === 0 ? (
        <EmptyState title={t("noneOpen")} />
      ) : (
        <ul className="space-y-3 text-sm">
          {data.checklists.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <Link href={`/o/${orgSlug}/hr/onboarding/${c.id}`} className="font-medium underline">
                {c.own
                  ? t("yours", { name: c.template.name })
                  : `${c.employee.firstName} ${c.employee.lastName} · ${c.template.name}`}
              </Link>
              <span className="text-muted">
                {t("progress", { done: c.progress.done, total: c.progress.total })}
              </span>
              {c.progress.overdue ? (
                <Badge tone="danger">{t("overdueCount", { count: c.progress.overdue })}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
