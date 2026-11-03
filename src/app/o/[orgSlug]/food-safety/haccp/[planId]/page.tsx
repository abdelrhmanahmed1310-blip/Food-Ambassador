import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ClassBadge, HaccpStatusBadge } from "@/components/foodsafety/haccp-badge";
import {
  ApprovePlanForm,
  HaccpControlPointForm,
  HaccpHazardForm,
  HaccpStepForm,
  LinkCheckpointForm,
} from "@/components/foodsafety/haccp-forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { Alert, Card, DescriptionList, EmptyState, PageHeader } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { checkpointsForPlan, getHaccpPlan } from "@/modules/foodsafety/haccp";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  addHazardAction,
  addStepAction,
  approvePlanAction,
  linkCheckpointAction,
  newVersionAction,
  removeHazardAction,
  removeStepAction,
  saveControlPointAction,
  unlinkCheckpointAction,
} from "../actions";

export default async function HaccpPlanPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/haccp/[planId]">) {
  const { orgSlug, planId } = await params;
  if (!isUuid(planId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const view = await notFoundOnAppError(getHaccpPlan(ctx, planId));
  const { plan, steps, problems, versions, deviations, can } = view;
  const [t, format, checkpoints] = await Promise.all([
    getTranslations(),
    getFormatter(),
    can.edit ? checkpointsForPlan(ctx, plan) : Promise.resolve([]),
  ]);
  const when = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: ctx.timeZone }) : "—";
  const day = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" }) : "—";
  const hazardsById = new Map(
    steps.flatMap((s) => s.hazards.map((h) => [h.id, { ...h, step: s.name }])),
  );
  const base = `/o/${orgSlug}/food-safety/haccp`;

  return (
    <>
      <PageHeader
        title={`${plan.code} v${plan.version} — ${plan.name}`}
        description={
          plan.branch ? `${plan.branch.code} — ${plan.branch.name}` : t("haccp.allBranches")
        }
        actions={
          <>
            <HaccpStatusBadge status={plan.status} />
            <a href={`${base}/${plan.id}/pdf`} className={buttonClass("secondary")}>
              {t("haccp.pdf")}
            </a>
          </>
        }
      />
      <div className="space-y-6">
        {plan.reviewOverdue ? <Alert tone="error">{t("haccp.reviewOverdue")}</Alert> : null}
        <Card>
          <DescriptionList
            items={[
              { label: t("haccp.scope"), value: plan.scope },
              { label: t("haccp.intendedUse"), value: plan.intendedUse ?? "—" },
              { label: t("haccp.team"), value: plan.team ?? "—" },
              {
                label: t("haccp.createdBy"),
                value: `${plan.createdBy ?? "—"} · ${when(plan.createdAt)}`,
              },
              ...(plan.approvedAt
                ? [
                    {
                      label: t("haccp.approvedBy"),
                      value: `${plan.approvedBy ?? "—"} · ${when(plan.approvedAt)}`,
                    },
                    { label: t("haccp.reviewDueOn"), value: day(plan.reviewDueOn) },
                  ]
                : []),
              {
                label: t("haccp.versions"),
                value: (
                  <span className="flex flex-wrap gap-2">
                    {versions.map((v) => (
                      <Link
                        key={v.id}
                        href={`${base}/${v.id}`}
                        className={`ltr-value text-xs hover:underline ${v.id === plan.id ? "font-semibold" : "text-primary"}`}
                      >
                        v{v.version} · {t(`haccp.statuses.${v.status}`)}
                      </Link>
                    ))}
                  </span>
                ),
              },
            ]}
          />
          {can.newVersion ? (
            <div className="mt-4">
              <ConfirmActionButton
                action={newVersionAction.bind(null, orgSlug, plan.id)}
                label={t("haccp.newVersion")}
                variant="secondary"
              />
            </div>
          ) : null}
        </Card>

        {plan.status === "DRAFT" ? (
          <Card title={t("haccp.readiness")}>
            {problems.length === 0 ? (
              <p className="text-success text-sm">{t("haccp.ready")}</p>
            ) : (
              <ul className="list-disc ps-5 text-sm" data-testid="haccp-problems">
                {problems.map((p, i) => {
                  const h = "hazardId" in p ? hazardsById.get(p.hazardId) : undefined;
                  return (
                    <li key={i}>
                      {t(`haccp.problems.${p.code}`)}
                      {h ? ` — ${h.step}: ${h.description}` : ""}
                    </li>
                  );
                })}
              </ul>
            )}
            {can.approve ? (
              <div className="mt-4">
                <ApprovePlanForm
                  action={approvePlanAction.bind(null, orgSlug, plan.id)}
                  defaultDate={addDays(businessDate(ctx.timeZone), 365)}
                />
              </div>
            ) : can.edit ? (
              <p className="text-muted mt-3 text-xs">{t("haccp.approverHint")}</p>
            ) : null}
          </Card>
        ) : null}

        {deviations.length > 0 ? (
          <Card title={t("haccp.deviations")}>
            <ul className="divide-border divide-y text-sm">
              {deviations.map((d) => (
                <li key={d.id} className="py-2">
                  <Link
                    href={`/o/${orgSlug}/food-safety/non-conformances/${d.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {d.number}
                  </Link>{" "}
                  {d.title} <span className="text-muted text-xs">· {when(d.raisedAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card title={t("haccp.flow")}>
          {steps.length === 0 ? (
            <EmptyState title={t("haccp.noSteps")} />
          ) : (
            <ol className="space-y-4">
              {steps.map((s) => (
                <li
                  key={s.id}
                  className="border-border rounded-lg border p-4"
                  data-testid="haccp-step"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-medium">
                      {s.position}. {s.name}
                      {s.description ? (
                        <span className="text-muted block text-xs font-normal">
                          {s.description}
                        </span>
                      ) : null}
                    </p>
                    {can.edit ? (
                      <ConfirmActionButton
                        action={removeStepAction.bind(null, orgSlug, plan.id, s.id)}
                        label={t("common.remove")}
                        variant="secondary"
                        confirmMessage={t("haccp.removeStepConfirm")}
                      />
                    ) : null}
                  </div>
                  {s.hazards.length === 0 ? (
                    <p className="text-muted mt-2 text-xs">{t("haccp.noHazards")}</p>
                  ) : (
                    <ul className="mt-3 space-y-3">
                      {s.hazards.map((h) => (
                        <li key={h.id} className="bg-surface-muted rounded-md p-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <ClassBadge value={h.classification} />
                            <span className="font-medium">{h.description}</span>
                            <span className="text-muted text-xs">
                              {t(`haccp.hazardTypes.${h.type}`)} ·{" "}
                              {t("haccp.riskScore", {
                                score: h.risk,
                                l: h.likelihood,
                                s: h.severity,
                              })}
                              {h.significant ? ` · ${t("haccp.significant")}` : ""}
                            </span>
                          </div>
                          {h.controlMeasures ? (
                            <p className="text-muted mt-1 text-xs">
                              {t("haccp.controlMeasures")}: {h.controlMeasures}
                            </p>
                          ) : null}
                          {h.treeResult && h.treeResult !== h.classification ? (
                            <p className="text-muted mt-1 text-xs">
                              {t("haccp.treeSaid", { result: h.treeResult })} — {h.justification}
                            </p>
                          ) : null}
                          {h.controlPoint ? (
                            <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                              <div>
                                <dt className="font-medium">{t("haccp.criticalLimit")}</dt>
                                <dd>{h.controlPoint.criticalLimit}</dd>
                              </div>
                              <div>
                                <dt className="font-medium">{t("haccp.monitoring")}</dt>
                                <dd>
                                  {h.controlPoint.monitoring} · {h.controlPoint.frequency}
                                  {h.controlPoint.responsible
                                    ? ` · ${h.controlPoint.responsible}`
                                    : ""}
                                </dd>
                              </div>
                              <div>
                                <dt className="font-medium">{t("haccp.correctiveAction")}</dt>
                                <dd>{h.controlPoint.correctiveAction}</dd>
                              </div>
                              <div>
                                <dt className="font-medium">{t("haccp.verification")}</dt>
                                <dd>{h.controlPoint.verification}</dd>
                              </div>
                              <div className="sm:col-span-2">
                                <dt className="font-medium">{t("haccp.monitoredBy")}</dt>
                                <dd>
                                  {h.controlPoint.checkpoints.length === 0 ? (
                                    <span className="text-muted">{t("haccp.noCheckpoints")}</span>
                                  ) : (
                                    <ul>
                                      {h.controlPoint.checkpoints.map((c) => (
                                        <li
                                          key={c.id}
                                          className="flex flex-wrap items-center gap-2"
                                        >
                                          <span className="ltr-value font-mono">
                                            {c.branch.code} · {c.code}
                                          </span>
                                          <span className="text-muted">
                                            {t("haccp.evidence", {
                                              readings: c.readings,
                                              outOfSpec: c.outOfSpec,
                                              last: c.lastReading ? when(c.lastReading) : "—",
                                            })}
                                          </span>
                                          {can.edit ? (
                                            <ConfirmActionButton
                                              action={unlinkCheckpointAction.bind(
                                                null,
                                                orgSlug,
                                                plan.id,
                                                h.controlPoint!.id,
                                                c.id,
                                              )}
                                              label={t("common.remove")}
                                              variant="secondary"
                                            />
                                          ) : null}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </dd>
                              </div>
                            </dl>
                          ) : null}
                          {can.edit ? (
                            <div className="mt-2 space-y-2">
                              {h.classification !== "PRP" ? (
                                <details>
                                  <summary className="text-primary cursor-pointer text-xs">
                                    {h.controlPoint
                                      ? t("haccp.editControlPoint")
                                      : t("haccp.setControlPoint")}
                                  </summary>
                                  <div className="mt-2">
                                    <HaccpControlPointForm
                                      action={saveControlPointAction.bind(
                                        null,
                                        orgSlug,
                                        plan.id,
                                        h.id,
                                      )}
                                      defaults={
                                        h.controlPoint
                                          ? {
                                              criticalLimit: h.controlPoint.criticalLimit,
                                              minValue: h.controlPoint.minValue?.toString(),
                                              maxValue: h.controlPoint.maxValue?.toString(),
                                              unit: h.controlPoint.unit ?? undefined,
                                              monitoring: h.controlPoint.monitoring,
                                              frequency: h.controlPoint.frequency,
                                              responsible: h.controlPoint.responsible ?? undefined,
                                              correctiveAction: h.controlPoint.correctiveAction,
                                              verification: h.controlPoint.verification,
                                              recordsKept: h.controlPoint.recordsKept ?? undefined,
                                            }
                                          : {}
                                      }
                                    />
                                  </div>
                                </details>
                              ) : null}
                              {h.controlPoint && checkpoints.length > 0 ? (
                                <LinkCheckpointForm
                                  action={linkCheckpointAction.bind(
                                    null,
                                    orgSlug,
                                    plan.id,
                                    h.controlPoint.id,
                                  )}
                                  checkpoints={checkpoints
                                    .filter(
                                      (c) =>
                                        !h.controlPoint!.checkpoints.some((x) => x.id === c.id),
                                    )
                                    .map((c) => ({
                                      value: c.id,
                                      label: `${c.branch.code} · ${c.code} — ${c.name} (${c.minCelsius ?? "…"} – ${c.maxCelsius ?? "…"} °C)`,
                                    }))}
                                />
                              ) : null}
                              <ConfirmActionButton
                                action={removeHazardAction.bind(null, orgSlug, plan.id, h.id)}
                                label={t("haccp.removeHazard")}
                                variant="secondary"
                              />
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
          {can.edit ? (
            <div className="mt-4">
              <HaccpStepForm action={addStepAction.bind(null, orgSlug, plan.id)} />
            </div>
          ) : null}
        </Card>

        {can.edit && steps.length > 0 ? (
          <Card title={t("haccp.addHazardTitle")}>
            <p className="text-muted mb-3 text-xs">{t("haccp.addHazardHint")}</p>
            <HaccpHazardForm
              action={addHazardAction.bind(null, orgSlug, plan.id)}
              steps={steps.map((s) => ({ value: s.id, label: `${s.position}. ${s.name}` }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
