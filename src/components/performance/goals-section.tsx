import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { GoalForm, GoalProgressForm } from "@/components/performance/forms";
import { Badge, Table, Td, Th } from "@/components/ui/primitives";
import { addGoalAction, updateGoalAction } from "@/app/o/[orgSlug]/hr/performance/actions";
import { REVIEW_TONE } from "@/app/o/[orgSlug]/hr/performance/status";

interface Goal {
  id: string;
  title: string;
  weight: number;
  progress: number;
  status: string;
  dueOn: Date | null;
  cycle: { name: string } | null;
}

/** An employee's goals and reviews (ADR-126). */
export async function GoalsSection({
  orgSlug,
  employeeId,
  goals,
  reviews,
  cycles,
  canSetGoals,
  canUpdate,
}: {
  orgSlug: string;
  employeeId: string;
  goals: Goal[];
  reviews: Array<{
    id: string;
    status: keyof typeof REVIEW_TONE;
    finalRating: number | null;
    cycle: { name: string };
  }>;
  cycles: Array<{ id: string; name: string }>;
  canSetGoals: boolean;
  canUpdate: boolean;
}) {
  const t = await getTranslations("performance");
  return (
    <div className="space-y-4" data-testid="employee-goals">
      {goals.length === 0 ? (
        <p className="text-muted text-sm">{t("noGoals")}</p>
      ) : (
        <Table label={t("goals")}>
          <thead>
            <tr>
              <Th>{t("goalTitle")}</Th>
              <Th>{t("cycle")}</Th>
              <Th>{t("weight")}</Th>
              <Th>{t("progress")}</Th>
            </tr>
          </thead>
          <tbody>
            {goals.map((g) => (
              <tr key={g.id}>
                <Td>
                  {g.title}
                  <span className="text-muted block text-xs">
                    {t(`goalStatuses.${g.status}`)}
                    {g.dueOn
                      ? ` · ${t("dueBy", { date: g.dueOn.toISOString().slice(0, 10) })}`
                      : ""}
                  </span>
                </Td>
                <Td>{g.cycle?.name ?? "—"}</Td>
                <Td className="tabular-nums">{g.weight}%</Td>
                <Td>
                  {canUpdate || canSetGoals ? (
                    <GoalProgressForm
                      action={updateGoalAction.bind(null, orgSlug, g.id)}
                      progress={g.progress}
                      status={g.status}
                      canSetStatus={canSetGoals}
                    />
                  ) : (
                    <span className="tabular-nums">{g.progress}%</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {reviews.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {reviews.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <Link
                href={`/o/${orgSlug}/hr/performance/reviews/${r.id}`}
                className="text-primary hover:underline"
              >
                {r.cycle.name}
              </Link>
              <Badge tone={REVIEW_TONE[r.status]}>{t(`reviewStatuses.${r.status}`)}</Badge>
              {r.finalRating ? <span>{t("finalShort", { rating: r.finalRating })}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canSetGoals ? (
        <details>
          <summary className="text-primary cursor-pointer text-sm">{t("addGoal")}</summary>
          <div className="mt-3">
            <GoalForm
              action={addGoalAction.bind(null, orgSlug, employeeId)}
              cycles={cycles.map((c) => ({ value: c.id, label: c.name }))}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
