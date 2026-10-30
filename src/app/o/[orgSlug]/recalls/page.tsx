import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { RecallStatusBadge } from "@/components/traceability/recall-badge";
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listRecalls } from "@/modules/traceability/recalls";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function RecallsPage({ params }: PageProps<"/o/[orgSlug]/recalls">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "traceability.view")) notFound();
  const [t, format, recalls] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listRecalls(ctx),
  ]);
  const dt = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: ctx.timeZone }) : "—";
  return (
    <>
      <PageHeader
        title={t("recalls.title")}
        description={t("recalls.hint")}
        actions={
          hasPermission(ctx.grants, "recalls.manage") ? (
            <LinkButton href={`/o/${orgSlug}/recalls/new`}>{t("recalls.new")}</LinkButton>
          ) : null
        }
      />
      {recalls.length === 0 ? (
        <EmptyState title={t("recalls.empty")} />
      ) : (
        <Table label={t("recalls.title")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("recalls.recallTitle")}</Th>
              <Th>{t("recalls.lots")}</Th>
              <Th>{t("recalls.activatedAt")}</Th>
              <Th>{t("recalls.closedAt")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {recalls.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link
                    href={`/o/${orgSlug}/recalls/${r.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {r.number}
                  </Link>
                </Td>
                <Td>{r.title}</Td>
                <Td className="tabular-nums">{r._count.lots}</Td>
                <Td className="whitespace-nowrap">{dt(r.activatedAt)}</Td>
                <Td className="whitespace-nowrap">
                  {dt(r.closedAt)}
                  {r.outcome ? (
                    <span className="text-muted block text-xs">
                      {t(`recalls.outcomes.${r.outcome}`)}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <RecallStatusBadge status={r.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
