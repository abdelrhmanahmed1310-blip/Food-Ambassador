import { getTranslations } from "next-intl/server";
import { LeaveRequestForm } from "@/components/hr/leave-forms";
import { LeaveTable } from "@/components/hr/leave-table";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { myLeave } from "@/modules/hr/leave";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { cancelLeaveAction, decideLeaveAction, requestLeaveAction } from "../../hr/leave/actions";

/** The signed-in employee's leave, and their team's requests to decide (ADR-081). */
export default async function MyLeavePage({ params }: PageProps<"/o/[orgSlug]/my/leave">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, ta, mine] = await Promise.all([
    getTranslations("leave"),
    getTranslations("attendance"),
    myLeave(ctx),
  ]);
  if (!mine)
    return (
      <>
        <PageHeader title={t("myTitle")} />
        <EmptyState title={ta("notLinked")} hint={ta("notLinkedHint")} />
      </>
    );
  return (
    <>
      <PageHeader title={t("myTitle")} description={t("myIntro", { year: mine.year })} />
      <div className="space-y-6">
        {mine.team.length > 0 ? (
          <Card title={t("teamRequests")}>
            <LeaveTable
              rows={mine.team}
              showEmployee
              actions={(r) => ({
                approve: decideLeaveAction.bind(null, orgSlug, r.id, "APPROVED"),
                reject: decideLeaveAction.bind(null, orgSlug, r.id, "REJECTED"),
              })}
            />
          </Card>
        ) : null}
        <Card title={t("balances", { year: mine.year })}>
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="leave-balances">
            {mine.balances
              .filter((b) => b.type.usesBalance && b.allocated)
              .map((b) => (
                <li key={b.type.id} className="border-border rounded-lg border p-3">
                  <p className="font-medium">{b.type.name}</p>
                  <p className="text-2xl font-bold tabular-nums">{b.remaining!.toFixed(0)}</p>
                  <p className="text-muted text-xs">
                    {t("balanceDetail", {
                      allocated: b.allocated!.toFixed(0),
                      approved: b.approved.toFixed(0),
                      pending: b.pending.toFixed(0),
                    })}
                  </p>
                </li>
              ))}
          </ul>
          {mine.balances.every((b) => !b.allocated) ? (
            <p className="text-muted text-sm">{t("noEntitlements")}</p>
          ) : null}
        </Card>
        <Card title={t("requestLeave")}>
          <LeaveRequestForm
            action={requestLeaveAction.bind(null, orgSlug, null)}
            types={mine.balances.map((b) => ({ value: b.type.id, label: b.type.name }))}
          />
        </Card>
        <Card title={t("myRequests")}>
          {mine.mine.length === 0 ? (
            <p className="text-muted text-sm">{t("noRequests")}</p>
          ) : (
            <LeaveTable
              rows={mine.mine}
              showEmployee={false}
              actions={(r) =>
                r.status === "PENDING"
                  ? { cancel: cancelLeaveAction.bind(null, orgSlug, r.id) }
                  : {}
              }
            />
          )}
        </Card>
      </div>
    </>
  );
}
