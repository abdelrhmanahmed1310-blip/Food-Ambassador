import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  AcknowledgeForm,
  FinalizeForm,
  ManagerReviewForm,
  SelfReviewForm,
  SkipForm,
} from "@/components/performance/forms";
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
import { getReview } from "@/modules/performance/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  acknowledgeAction,
  finalizeAction,
  managerReviewAction,
  selfReviewAction,
  skipAction,
} from "../../actions";
import { REVIEW_TONE } from "../../status";

/** One performance review, as the person may see and act on it (ADR-126). */
export default async function ReviewPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/performance/reviews/[reviewId]">) {
  const { orgSlug, reviewId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!isUuid(reviewId)) notFound();
  const d = await getReview(ctx, reviewId).catch(() => null);
  if (!d) notFound();
  const t = await getTranslations("performance");
  const r = d.review;
  const goalOptions = d.goals.map((g) => ({ value: g.id, label: `${g.title} (${g.weight}%)` }));
  const text = (v: string | null) => (v ? <span className="whitespace-pre-wrap">{v}</span> : "—");
  return (
    <>
      <PageHeader
        title={`${r.employee.firstName} ${r.employee.lastName} · ${r.cycle.name}`}
        description={`${r.employee.number} · ${r.employee.jobTitle} · ${t("reviewer")}: ${r.reviewer ? `${r.reviewer.firstName} ${r.reviewer.lastName}` : t("hrReviews")}`}
        actions={<Badge tone={REVIEW_TONE[r.status]}>{t(`reviewStatuses.${r.status}`)}</Badge>}
      />
      <div className="space-y-6" data-testid="review">
        {d.goals.length > 0 ? (
          <Table label={t("goals")}>
            <thead>
              <tr>
                <Th>{t("goalTitle")}</Th>
                <Th>{t("weight")}</Th>
                <Th>{t("progress")}</Th>
                <Th>{t("selfRating")}</Th>
                <Th>{t("managerRating")}</Th>
              </tr>
            </thead>
            <tbody>
              {d.goals.map((g) => (
                <tr key={g.id}>
                  <Td>{g.title}</Td>
                  <Td className="tabular-nums">{g.weight}%</Td>
                  <Td className="tabular-nums">{g.progress}%</Td>
                  <Td className="tabular-nums">{g.selfRating ?? "—"}</Td>
                  <Td className="tabular-nums">{g.managerRating ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        <Card>
          <DescriptionList
            items={[
              { label: t("selfComment"), value: text(r.selfComment) },
              { label: t("goalScore"), value: d.score === null ? "—" : String(d.score) },
              {
                label: t("overallRating"),
                value: r.managerRating
                  ? `${r.managerRating} — ${t(`ratings.${r.managerRating}`)}`
                  : "—",
              },
              { label: t("strengths"), value: text(r.managerStrengths) },
              { label: t("improvements"), value: text(r.managerImprovements) },
              { label: t("employeeComment"), value: text(r.employeeComment) },
              ...(r.finalRating
                ? [
                    {
                      label: t("finalRating"),
                      value: `${r.finalRating} — ${t(`ratings.${r.finalRating}`)}`,
                    },
                    { label: t("finalReason"), value: text(r.finalReason) },
                  ]
                : []),
              ...(r.skipReason ? [{ label: t("skipReason"), value: r.skipReason }] : []),
            ]}
          />
        </Card>
        {d.can.self ? (
          <Card title={t("selfReview")}>
            <p className="text-muted mb-3 text-sm">{t("selfDue", { date: r.cycle.selfDueOn })}</p>
            <SelfReviewForm
              action={selfReviewAction.bind(null, orgSlug, r.id)}
              goals={goalOptions}
            />
          </Card>
        ) : null}
        {d.can.manager ? (
          <Card title={t("managerReview")}>
            <p className="text-muted mb-3 text-sm">
              {t("managerDue", { date: r.cycle.managerDueOn })}
            </p>
            <ManagerReviewForm
              action={managerReviewAction.bind(null, orgSlug, r.id)}
              goals={goalOptions}
            />
          </Card>
        ) : null}
        {d.can.acknowledge ? (
          <Card title={t("acknowledgeTitle")}>
            <AcknowledgeForm action={acknowledgeAction.bind(null, orgSlug, r.id)} />
          </Card>
        ) : null}
        {d.can.finalize ? (
          <Card title={t("finalizeTitle")}>
            <FinalizeForm
              action={finalizeAction.bind(null, orgSlug, r.id)}
              managerRating={r.managerRating}
            />
          </Card>
        ) : null}
        {d.can.skip ? <SkipForm action={skipAction.bind(null, orgSlug, r.id)} /> : null}
      </div>
    </>
  );
}
