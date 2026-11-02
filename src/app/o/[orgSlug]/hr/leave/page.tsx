import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LeaveTable } from "@/components/hr/leave-table";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listLeaveRequests } from "@/modules/hr/leave";
import { canViewHr } from "@/modules/hr/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { cancelLeaveAction, decideLeaveAction } from "./actions";

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;

/** Leave requests for HR (ADR-081). */
export default async function LeavePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/hr/leave">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const sp = await searchParams;
  const status = (Array.isArray(sp.status) ? sp.status[0] : sp.status) ?? "PENDING";
  const [t, rows] = await Promise.all([
    getTranslations("leave"),
    listLeaveRequests(ctx, status || undefined),
  ]);
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("intro")}
        actions={
          holdsAnyGrant(ctx.grants, "hr.manage") ? (
            <LinkButton href={`/o/${orgSlug}/hr/leave/types`} variant="secondary">
              {t("types")}
            </LinkButton>
          ) : null
        }
      />
      <form method="get" className="mb-4 flex items-end gap-2">
        <label htmlFor="status" className="sr-only">
          {t("status")}
        </label>
        <select id="status" name="status" defaultValue={status} className={`${inputClass} w-48`}>
          <option value="">{t("all")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`statuses.${s}`)}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass("secondary")}>
          {t("show")}
        </button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={t("noRequests")} />
      ) : (
        <Card>
          <LeaveTable
            rows={rows}
            showEmployee
            actions={(r) => {
              const row = rows.find((x) => x.id === r.id)!;
              return row.canDecide
                ? {
                    approve: decideLeaveAction.bind(null, orgSlug, r.id, "APPROVED"),
                    reject: decideLeaveAction.bind(null, orgSlug, r.id, "REJECTED"),
                  }
                : r.status === "APPROVED" &&
                    row.startDate.toISOString().slice(0, 10) >
                      new Date().toISOString().slice(0, 10) &&
                    holdsAnyGrant(ctx.grants, "hr.manage")
                  ? { cancel: cancelLeaveAction.bind(null, orgSlug, r.id) }
                  : {};
            }}
          />
        </Card>
      )}
    </>
  );
}
