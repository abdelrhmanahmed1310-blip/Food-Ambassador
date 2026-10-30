import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getRun } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";

export default async function RunPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/runs/[runId]">) {
  const { orgSlug, runId } = await params;
  if (!isUuid(runId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const run = await notFoundOnAppError(getRun(ctx, runId));
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  return (
    <>
      <PageHeader
        title={run.template.name}
        description={format.dateTime(run.completedAt, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: ctx.timeZone,
        })}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("foodSafety.branch"), value: `${run.branch.code} — ${run.branch.name}` },
              { label: t("foodSafety.completedBy"), value: <bdi>{run.completedBy ?? "—"}</bdi> },
              {
                label: t("common.status"),
                value:
                  run.failedCount === 0
                    ? t("foodSafety.allPassed")
                    : t("foodSafety.failedCount", { count: run.failedCount }),
              },
              ...(run.nonConformance
                ? [
                    {
                      label: t("foodSafety.nonConformance"),
                      value: (
                        <Link
                          href={`/o/${orgSlug}/food-safety/non-conformances/${run.nonConformance.id}`}
                          className="ltr-value text-primary font-mono hover:underline"
                        >
                          {run.nonConformance.number}
                        </Link>
                      ),
                    },
                  ]
                : []),
              { label: t("common.note"), value: run.note ?? "—" },
            ]}
          />
        </Card>
        <Table label={t("foodSafety.items")}>
          <thead>
            <tr>
              <Th>{t("foodSafety.itemText")}</Th>
              <Th>{t("foodSafety.answer")}</Th>
              <Th>{t("common.status")}</Th>
              <Th>{t("common.note")}</Th>
            </tr>
          </thead>
          <tbody>
            {run.answers.map((a) => (
              <tr key={a.id}>
                <Td>{a.text}</Td>
                <Td className="tabular-nums">
                  {a.kind === "YES_NO" ? (
                    a.yes ? (
                      t("common.yes")
                    ) : (
                      t("common.no")
                    )
                  ) : (
                    <span className="ltr-value">{a.value?.toFixed()}</span>
                  )}
                </Td>
                <Td>
                  <Badge tone={a.ok ? "success" : "danger"}>
                    {a.ok ? t("foodSafety.pass") : t("foodSafety.fail")}
                  </Badge>
                </Td>
                <Td>{a.note ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}
