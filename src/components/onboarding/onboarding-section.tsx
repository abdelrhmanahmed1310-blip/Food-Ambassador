import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import { startOnboardingAction } from "@/app/o/[orgSlug]/hr/onboarding/actions";
import type { employeeOnboarding } from "@/modules/rosters/onboarding";
import { StartOnboardingForm } from "./forms";

type Data = Awaited<ReturnType<typeof employeeOnboarding>>;

/** An employee's onboarding checklists, and starting one (ADR-128). */
export async function OnboardingSection({
  orgSlug,
  employeeId,
  data,
}: {
  orgSlug: string;
  employeeId: string;
  data: Data;
}) {
  const t = await getTranslations("onboarding");
  return (
    <div className="space-y-4">
      {data.checklists.length ? (
        <ul className="space-y-2 text-sm">
          {data.checklists.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <Link href={`/o/${orgSlug}/hr/onboarding/${c.id}`} className="font-medium underline">
                {c.template.name}
              </Link>
              <span className="text-muted">
                {t("progress", { done: c.progress.done, total: c.progress.total })}
              </span>
              {c.completedAt ? (
                <Badge tone="success">{t("completed")}</Badge>
              ) : c.cancelledAt ? (
                <Badge tone="muted">{t("cancelled")}</Badge>
              ) : c.progress.overdue ? (
                <Badge tone="danger">{t("overdueCount", { count: c.progress.overdue })}</Badge>
              ) : (
                <Badge tone="warning">{t("open")}</Badge>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted text-sm">{t("none")}</p>
      )}
      {data.can.start && data.templates.length ? (
        <StartOnboardingForm
          action={startOnboardingAction.bind(null, orgSlug, employeeId)}
          templates={data.templates.map((x) => ({ value: x.id, label: x.name }))}
        />
      ) : null}
    </div>
  );
}
