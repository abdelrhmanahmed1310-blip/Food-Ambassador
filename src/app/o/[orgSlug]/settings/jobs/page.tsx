import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listJobs } from "@/modules/jobs/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const tone = { QUEUED: "muted", RUNNING: "warning", DONE: "success", FAILED: "danger" } as const;

/** The organization's background jobs (ADR-087). */
export default async function JobsPage({ params }: PageProps<"/o/[orgSlug]/settings/jobs">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "org.settings.manage")) notFound();
  const [t, format, jobs] = await Promise.all([
    getTranslations("jobs"),
    getFormatter(),
    listJobs(ctx),
  ]);
  const when = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "short", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  return (
    <>
      <PageHeader title={t("title")} description={t("intro")} />
      <div className="space-y-6">
        <Alert tone="info">{t("workerNote")}</Alert>
        {jobs.length === 0 ? (
          <EmptyState title={t("none")} />
        ) : (
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("kind")}</Th>
                <Th>{t("status")}</Th>
                <Th>{t("attempts")}</Th>
                <Th>{t("runAt")}</Th>
                <Th>{t("finished")}</Th>
                <Th>{t("outcome")}</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} data-testid="job-row">
                  <Td>
                    {t.has(`kinds.${j.kind.replace(/\./g, "_")}`)
                      ? t(`kinds.${j.kind.replace(/\./g, "_")}` as "kinds.attention_digest")
                      : j.kind}
                  </Td>
                  <Td>
                    <Badge tone={tone[j.status]}>{t(`statuses.${j.status}`)}</Badge>
                  </Td>
                  <Td className="tabular-nums">
                    {j.attempts} / {j.maxAttempts}
                  </Td>
                  <Td className="ltr-value">{when(j.runAt)}</Td>
                  <Td className="ltr-value">{when(j.finishedAt)}</Td>
                  <Td className="text-xs">
                    {j.lastError ? (
                      <span className="text-danger">{j.lastError}</span>
                    ) : j.result ? (
                      <span className="ltr-value font-mono">
                        {Object.entries(j.result as Record<string, number>)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" ")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
