import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { HaccpStatusBadge } from "@/components/foodsafety/haccp-badge";
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listHaccpPlans } from "@/modules/foodsafety/haccp";
import { businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function HaccpPlansPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/haccp">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const [t, format, plans] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listHaccpPlans(ctx),
  ]);
  const today = businessDate(ctx.timeZone);
  const base = `/o/${orgSlug}/food-safety/haccp`;
  return (
    <>
      <PageHeader
        title={t("haccp.title")}
        description={t("haccp.hint")}
        actions={
          holdsAnyGrant(ctx.grants, "foodsafety.manage") ? (
            <LinkButton href={`${base}/new`}>{t("haccp.new")}</LinkButton>
          ) : null
        }
      />
      {plans.length === 0 ? (
        <EmptyState title={t("haccp.empty")} />
      ) : (
        <Table label={t("haccp.title")}>
          <thead>
            <tr>
              <Th>{t("haccp.code")}</Th>
              <Th>{t("haccp.name")}</Th>
              <Th>{t("haccp.branch")}</Th>
              <Th>{t("haccp.controlPoints")}</Th>
              <Th>{t("haccp.reviewDueOn")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <Td>
                  <Link
                    href={`${base}/${p.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {p.code} v{p.version}
                  </Link>
                </Td>
                <Td>{p.name}</Td>
                <Td>{p.branch ? `${p.branch.code} — ${p.branch.name}` : t("haccp.allBranches")}</Td>
                <Td className="tabular-nums">{p._count.controlPoints}</Td>
                <Td className="whitespace-nowrap">
                  {p.reviewDueOn ? (
                    <span
                      className={
                        p.reviewDueOn.toISOString().slice(0, 10) <= today ? "text-danger" : ""
                      }
                    >
                      {format.dateTime(p.reviewDueOn, { dateStyle: "medium", timeZone: "UTC" })}
                    </span>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>
                  <HaccpStatusBadge status={p.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
