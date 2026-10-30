import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { NcStatusBadge, SeverityBadge } from "@/components/foodsafety/badges";
import { CorrectiveActionForm, SingleTextForm } from "@/components/foodsafety/forms";
import { Alert, Badge, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getNonConformance } from "@/modules/foodsafety/nonconformances";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  addActionAction,
  closeNcAction,
  completeActionAction,
  investigateAction,
  verifyActionAction,
} from "../../actions";

export default async function NonConformancePage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/non-conformances/[ncId]">) {
  const { orgSlug, ncId } = await params;
  if (!isUuid(ncId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const nc = await notFoundOnAppError(getNonConformance(ctx, ncId));
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const dt = (d: Date | null) =>
    d
      ? format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone })
      : "—";
  const tone = { OPEN: "neutral", DONE: "warning", VERIFIED: "success" } as const;
  return (
    <>
      <PageHeader
        title={`${nc.number} — ${nc.title}`}
        description={`${nc.branch.code} — ${nc.branch.name}`}
        actions={
          <>
            <SeverityBadge severity={nc.severity} />
            <NcStatusBadge status={nc.status} />
          </>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("foodSafety.description"),
                value: <span className="whitespace-pre-line">{nc.description}</span>,
              },
              { label: t("foodSafety.source"), value: t(`foodSafety.sources.${nc.source}`) },
              {
                label: t("foodSafety.raisedBy"),
                value: (
                  <>
                    <bdi>{nc.names.raisedBy ?? "—"}</bdi> · <bdi>{dt(nc.raisedAt)}</bdi>
                  </>
                ),
              },
              { label: t("foodSafety.rootCause"), value: nc.rootCause ?? "—" },
              ...(nc.closedAt
                ? [
                    {
                      label: t("foodSafety.closedBy"),
                      value: (
                        <>
                          <bdi>{nc.names.closedBy ?? "—"}</bdi> · <bdi>{dt(nc.closedAt)}</bdi> —{" "}
                          <bdi>{nc.closeNote}</bdi>
                        </>
                      ),
                    },
                  ]
                : []),
              ...(nc.runs.length > 0
                ? [
                    {
                      label: t("foodSafety.checklist"),
                      value: nc.runs.map((r) => (
                        <Link
                          key={r.id}
                          href={`/o/${orgSlug}/food-safety/runs/${r.id}`}
                          className="text-primary block hover:underline"
                        >
                          {r.template.name} · {dt(r.completedAt)}
                        </Link>
                      )),
                    },
                  ]
                : []),
            ]}
          />
        </Card>

        <Card title={t("foodSafety.correctiveActions")}>
          {nc.actions.length === 0 ? (
            <p className="text-muted text-sm">{t("foodSafety.noActions")}</p>
          ) : (
            <ul className="space-y-4">
              {nc.actions.map((a) => (
                <li
                  key={a.id}
                  className="border-border rounded-lg border p-4"
                  data-testid="corrective-action"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{a.description}</p>
                    <span className="flex gap-2">
                      <Badge tone={tone[a.status]}>
                        {t(`foodSafety.actionStatuses.${a.status}`)}
                      </Badge>
                      {a.overdue ? <Badge tone="danger">{t("foodSafety.overdue")}</Badge> : null}
                    </span>
                  </div>
                  <p className="text-muted mt-1 text-sm">
                    {t("foodSafety.owner")}: <bdi>{a.owner ?? "—"}</bdi> · {t("foodSafety.dueOn")}:{" "}
                    {a.dueOn?.toISOString().slice(0, 10) ?? "—"}
                  </p>
                  {a.doneAt ? (
                    <p className="mt-1 text-sm">
                      {t("foodSafety.doneBy")}: <bdi>{a.doneBy}</bdi> · <bdi>{dt(a.doneAt)}</bdi> —{" "}
                      <bdi>{a.doneNote}</bdi>
                    </p>
                  ) : null}
                  {a.verifiedAt ? (
                    <p className="mt-1 text-sm">
                      {t("foodSafety.verifiedBy")}: <bdi>{a.verifiedBy}</bdi> ·{" "}
                      <bdi>{dt(a.verifiedAt)}</bdi> — <bdi>{a.verifyNote}</bdi>
                    </p>
                  ) : null}
                  {nc.can.manage && a.status === "OPEN" ? (
                    <div className="mt-3">
                      <SingleTextForm
                        action={completeActionAction.bind(null, orgSlug, nc.id, a.id)}
                        name="note"
                        label={t("foodSafety.whatWasDone")}
                        submitLabel={t("foodSafety.markDone")}
                      />
                    </div>
                  ) : null}
                  {a.canVerify ? (
                    <div className="mt-3">
                      <SingleTextForm
                        action={verifyActionAction.bind(null, orgSlug, nc.id, a.id)}
                        name="note"
                        label={t("foodSafety.verification")}
                        submitLabel={t("foodSafety.verify")}
                        variant="primary"
                      />
                    </div>
                  ) : nc.can.manage && a.status === "DONE" ? (
                    <p className="text-muted mt-3 text-sm">{t("foodSafety.verifyByOther")}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {nc.can.manage ? (
            <div className="mt-4">
              <CorrectiveActionForm
                action={addActionAction.bind(null, orgSlug, nc.id)}
                members={nc.members.map((m) => ({ value: m.id, label: m.name }))}
              />
            </div>
          ) : null}
        </Card>

        {nc.can.manage ? (
          <Card title={t("foodSafety.investigation")}>
            <SingleTextForm
              action={investigateAction.bind(null, orgSlug, nc.id)}
              name="rootCause"
              label={t("foodSafety.rootCause")}
              submitLabel={t("common.save")}
            />
          </Card>
        ) : null}
        {nc.can.close ? (
          <Card title={t("foodSafety.closeNc")}>
            <SingleTextForm
              action={closeNcAction.bind(null, orgSlug, nc.id)}
              name="note"
              label={t("foodSafety.closeNote")}
              submitLabel={t("foodSafety.closeNc")}
              variant="primary"
            />
          </Card>
        ) : nc.can.manage ? (
          <Alert tone="info">{t("foodSafety.closeBlocked")}</Alert>
        ) : null}
      </div>
    </>
  );
}
