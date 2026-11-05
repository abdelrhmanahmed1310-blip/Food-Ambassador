import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AddApplicationForm, DecisionForm, ReasonForm } from "@/components/recruitment/forms";
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
import { getOpening } from "@/modules/recruitment/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { addApplicationAction, closeOpeningAction, decideOpeningAction } from "../../actions";
import { OPENING_TONE, STAGE_TONE } from "../../status";

/** An opening, its approval and its candidates (ADR-129). */
export default async function OpeningPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/recruitment/openings/[openingId]">) {
  const { orgSlug, openingId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!isUuid(openingId)) notFound();
  const [t, r] = await Promise.all([getTranslations("recruitment"), getOpening(ctx, openingId)]);
  const o = r.opening;
  const base = `/o/${orgSlug}/hr/recruitment`;
  return (
    <>
      <PageHeader
        title={`${o.number} · ${o.jobTitle}`}
        description={`${r.branch.code} — ${r.branch.name}`}
        actions={<Badge tone={OPENING_TONE[o.status]}>{t(`openingStatuses.${o.status}`)}</Badge>}
      />
      <div className="space-y-6">
        <Card title={t("details")}>
          <DescriptionList
            items={[
              { label: t("places"), value: `${o.hired} / ${o.headcount}` },
              { label: t("employmentType"), value: t(`employmentTypes.${o.employmentType}`) },
              { label: t("reason"), value: t(`reasons.${o.reason}`) },
              {
                label: t("plan"),
                value: o.beyondPlan ? t("beyondPlan", { count: o.beyondPlan }) : t("withinPlan"),
              },
              ...(o.targetStartOn
                ? [{ label: t("targetStart"), value: o.targetStartOn.toISOString().slice(0, 10) }]
                : []),
              ...(o.description ? [{ label: t("description"), value: o.description }] : []),
              ...(o.decisionNote ? [{ label: t("decisionNote"), value: o.decisionNote }] : []),
              ...(o.closeReason ? [{ label: t("closeReason"), value: o.closeReason }] : []),
            ]}
          />
        </Card>
        {r.can.decide ? (
          <Card title={t("approval")}>
            <DecisionForm action={decideOpeningAction.bind(null, orgSlug, o.id)} />
          </Card>
        ) : null}
        <Card title={t("candidates")}>
          {r.applications.length === 0 ? (
            <p className="text-muted text-sm">{t("noCandidates")}</p>
          ) : (
            <Table label={t("candidates")}>
              <thead>
                <tr>
                  <Th>{t("candidate")}</Th>
                  <Th>{t("source")}</Th>
                  <Th>{t("stage")}</Th>
                  <Th>{t("scorecards")}</Th>
                </tr>
              </thead>
              <tbody>
                {r.applications.map((a) => (
                  <tr key={a.id} data-testid="application-row">
                    <Td>
                      <Link href={`${base}/applications/${a.id}`} className="font-medium underline">
                        {a.candidate.firstName} {a.candidate.lastName}
                      </Link>
                    </Td>
                    <Td>{t(`sources.${a.candidate.source}`)}</Td>
                    <Td>
                      <Badge tone={STAGE_TONE[a.stage]}>{t(`stages.${a.stage}`)}</Badge>
                    </Td>
                    <Td className="tabular-nums">
                      {a.scorecards.count
                        ? t("scoreLine", {
                            average: a.scorecards.average ?? 0,
                            count: a.scorecards.count,
                          })
                        : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {r.can.manage ? (
          <Card title={t("addCandidate")}>
            <AddApplicationForm
              action={addApplicationAction.bind(null, orgSlug, o.id)}
              candidates={r.candidates.map((c) => ({
                value: c.id,
                label: `${c.firstName} ${c.lastName}${c.email ? ` (${c.email})` : ""}`,
              }))}
            />
          </Card>
        ) : null}
        {r.can.close ? (
          <ReasonForm
            action={closeOpeningAction.bind(null, orgSlug, o.id)}
            label={t("closeOpening")}
          />
        ) : null}
      </div>
    </>
  );
}
