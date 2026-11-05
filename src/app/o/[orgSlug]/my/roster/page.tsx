import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { myRoster } from "@/modules/rosters/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { hm, OUTCOME_TONE, outcomeOf } from "../../hr/rosters/status";

/** The signed-in employee's published shifts (ADR-128). */
export default async function MyRosterPage({ params }: PageProps<"/o/[orgSlug]/my/roster">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const data = await myRoster(ctx);
  if (!data) notFound();
  const [t, format] = await Promise.all([getTranslations("rosters"), getFormatter()]);
  return (
    <>
      <PageHeader title={t("myTitle")} description={t("myHint")} />
      {data.shifts.length === 0 ? (
        <EmptyState title={t("noShifts")} />
      ) : (
        <Table label={t("myTitle")}>
          <thead>
            <tr>
              <Th>{t("day")}</Th>
              <Th>{t("times")}</Th>
              <Th>{t("branch")}</Th>
              <Th>{t("status")}</Th>
            </tr>
          </thead>
          <tbody>
            {data.shifts.map((s) => {
              const day = s.day.toISOString().slice(0, 10);
              const o = outcomeOf(s.comparison);
              return (
                <tr key={s.id} data-testid="my-shift">
                  <Td>
                    {format.dateTime(new Date(`${day}T12:00:00Z`), { dateStyle: "full" })}
                    {day === data.today ? (
                      <span className="ms-2">
                        <Badge tone="neutral">{t("today")}</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">
                    <Link href={`/o/${orgSlug}/hr/rosters/shifts/${s.id}`} className="underline">
                      {s.startTime}–{s.endTime}
                    </Link>
                  </Td>
                  <Td>{s.branch.code}</Td>
                  <Td>
                    {s.cancelledAt ? (
                      <Badge tone="muted">{t("cancelled")}</Badge>
                    ) : o ? (
                      <Badge tone={OUTCOME_TONE[o]}>{t(`outcomes.${o}`)}</Badge>
                    ) : null}
                    {s.comparison?.workedMinutes ? (
                      <span className="text-muted ms-2 text-xs">
                        {t("workedValue", { time: hm(s.comparison.workedMinutes) })}
                      </span>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}
