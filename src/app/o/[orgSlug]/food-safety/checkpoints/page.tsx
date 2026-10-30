import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { SpecBadge } from "@/components/foodsafety/badges";
import { CheckpointForm } from "@/components/foodsafety/forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { branchOptions, listCheckpoints } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createCheckpointAction, setCheckpointArchivedAction } from "../actions";

export default async function CheckpointsPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/checkpoints">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const manage = holdsAnyGrant(ctx.grants, "foodsafety.manage");
  const [t, format, checkpoints, branches] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listCheckpoints(ctx),
    manage ? branchOptions(ctx, "foodsafety.manage") : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader
        title={t("foodSafety.checkpointsTitle")}
        description={t("foodSafety.checkpointsHint")}
      />
      <div className="space-y-6">
        {manage ? (
          <Card title={t("foodSafety.newCheckpoint")}>
            <CheckpointForm
              action={createCheckpointAction.bind(null, orgSlug)}
              branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            />
          </Card>
        ) : null}
        {checkpoints.length === 0 ? (
          <EmptyState title={t("foodSafety.noCheckpoints")} />
        ) : (
          <Table label={t("foodSafety.checkpointsTitle")}>
            <thead>
              <tr>
                <Th>{t("foodSafety.branch")}</Th>
                <Th>{t("foodSafety.checkpoint")}</Th>
                <Th>{t("foodSafety.kind")}</Th>
                <Th>{t("foodSafety.limits")}</Th>
                <Th>{t("foodSafety.lastReading")}</Th>
                {manage ? <Th>{t("common.actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {checkpoints.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{c.branch.code}</span>
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{c.code}</span> — {c.name}
                  </Td>
                  <Td>{t(`foodSafety.kinds.${c.kind}`)}</Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {c.minCelsius ? c.minCelsius.toFixed() : "…"} –{" "}
                      {c.maxCelsius ? c.maxCelsius.toFixed() : "…"} °C
                    </span>
                  </Td>
                  <Td>
                    {c.last ? (
                      <>
                        <span className="ltr-value tabular-nums">
                          {c.last.valueCelsius?.toFixed()} °C
                        </span>{" "}
                        <SpecBadge inSpec={c.last.inSpec} />
                        <span className="text-muted block text-xs">
                          {format.dateTime(c.last.recordedAt, {
                            dateStyle: "medium",
                            timeStyle: "short",
                            timeZone: ctx.timeZone,
                          })}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  {manage ? (
                    <Td>
                      {hasPermission(ctx.grants, "foodsafety.manage", { branchId: c.branchId }) ? (
                        <ConfirmActionButton
                          action={setCheckpointArchivedAction.bind(null, orgSlug, c.id, true)}
                          label={t("common.archive")}
                          variant="secondary"
                        />
                      ) : null}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
