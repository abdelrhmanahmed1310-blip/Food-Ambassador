import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { OpeningForm, RetentionForm } from "@/components/recruitment/forms";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import {
  canViewRecruitment,
  getRecruitmentSettings,
  isOrgHr,
  listOpenings,
} from "@/modules/recruitment/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { requestOpeningAction, saveRetentionAction } from "./actions";
import { OPENING_TONE } from "./status";

const FILTERS = ["", "PENDING_APPROVAL", "OPEN", "FILLED", "CLOSED", "REJECTED"] as const;

/** Job openings (ADR-129). */
export default async function RecruitmentPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/hr/recruitment">) {
  const { orgSlug } = await params;
  const { status } = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canViewRecruitment(ctx)) notFound();
  const [t, data, settings] = await Promise.all([
    getTranslations("recruitment"),
    listOpenings(ctx, status),
    getRecruitmentSettings(ctx),
  ]);
  const base = `/o/${orgSlug}/hr/recruitment`;
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("hint")}
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`${base}/candidates`} variant="secondary">
              {t("candidates")}
            </LinkButton>
            <LinkButton href={`/o/${orgSlug}/hr/workforce`} variant="secondary">
              {t("workforce")}
            </LinkButton>
          </div>
        }
      />
      <div className="space-y-6">
        <nav className="flex flex-wrap gap-3 text-sm">
          {FILTERS.map((f) => (
            <Link
              key={f || "live"}
              href={f ? `${base}?status=${f}` : base}
              className={(status ?? "") === f ? "font-semibold underline" : "underline"}
            >
              {f ? t(`openingStatuses.${f}`) : t("live")}
            </Link>
          ))}
        </nav>
        {data.openings.length === 0 ? (
          <EmptyState title={t("noOpenings")} />
        ) : (
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("number")}</Th>
                <Th>{t("jobTitle")}</Th>
                <Th>{t("branch")}</Th>
                <Th>{t("places")}</Th>
                <Th>{t("inPlay")}</Th>
                <Th>{t("status")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.openings.map((o) => (
                <tr key={o.id}>
                  <Td>
                    <Link href={`${base}/openings/${o.id}`} className="font-medium underline">
                      {o.number}
                    </Link>
                  </Td>
                  <Td>{o.jobTitle}</Td>
                  <Td>{o.branch.code}</Td>
                  <Td className="tabular-nums">
                    {o.hired} / {o.headcount}
                    {o.beyondPlan ? (
                      <span className="text-muted ms-2 text-xs">
                        {t("beyondPlan", { count: o.beyondPlan })}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">{o.active}</Td>
                  <Td>
                    <Badge tone={OPENING_TONE[o.status]}>{t(`openingStatuses.${o.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data.can.request && data.branches.length ? (
          <Card title={t("requestOpening")}>
            <OpeningForm
              action={requestOpeningAction.bind(null, orgSlug)}
              branches={data.branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
              departments={data.departments.map((d) => ({ value: d.id, label: d.name }))}
            />
          </Card>
        ) : null}
        {isOrgHr(ctx) ? (
          <Card title={t("retention")}>
            <RetentionForm
              action={saveRetentionAction.bind(null, orgSlug)}
              days={settings?.candidateRetentionDays?.toString() ?? ""}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
