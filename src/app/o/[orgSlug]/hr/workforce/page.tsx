import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PositionForm } from "@/components/recruitment/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { canViewHr } from "@/modules/hr/service";
import { canViewRecruitment, workforcePlan } from "@/modules/recruitment/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { setPositionAction } from "../recruitment/actions";

/** Planned positions per branch against people in post and openings (ADR-129). */
export default async function WorkforcePage({ params }: PageProps<"/o/[orgSlug]/hr/workforce">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx) && !canViewRecruitment(ctx)) notFound();
  const [t, plan] = await Promise.all([getTranslations("recruitment"), workforcePlan(ctx)]);
  const code = new Map(plan.branches.map((b) => [b.id, b.code]));
  return (
    <>
      <PageHeader title={t("workforce")} description={t("workforceHint")} />
      <div className="space-y-6">
        {plan.rows.length === 0 ? (
          <EmptyState title={t("noPlan")} />
        ) : (
          <Table label={t("workforce")}>
            <thead>
              <tr>
                <Th>{t("branch")}</Th>
                <Th>{t("jobTitle")}</Th>
                <Th>{t("planned")}</Th>
                <Th>{t("filled")}</Th>
                <Th>{t("inRecruitment")}</Th>
                <Th>{t("gap")}</Th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={`${r.branchId}-${r.jobTitle}`} data-testid="plan-row">
                  <Td>{code.get(r.branchId) ?? "—"}</Td>
                  <Td>{r.jobTitle}</Td>
                  <Td className="tabular-nums">{r.planned}</Td>
                  <Td className="tabular-nums">{r.filled}</Td>
                  <Td className="tabular-nums">{r.inRecruitment}</Td>
                  <Td>
                    {r.gap > 0 ? (
                      <Badge tone="warning">{t("toFill", { count: r.gap })}</Badge>
                    ) : r.gap < 0 ? (
                      <Badge tone="danger">{t("overPlan", { count: -r.gap })}</Badge>
                    ) : (
                      <Badge tone="success">{t("onPlan")}</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {plan.can.plan.length ? (
          <Card title={t("setPosition")}>
            <PositionForm
              action={setPositionAction.bind(null, orgSlug)}
              branches={plan.can.plan.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
