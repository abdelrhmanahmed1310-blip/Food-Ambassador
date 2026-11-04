import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { splitElapsed } from "@/modules/traceability/mock-recall-rules";
import { listMockRecalls } from "@/modules/traceability/mock-recalls";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { productName } from "@/server/inventory-view";
import { MockRecallBadge } from "./badges";

export default async function MockRecallsPage({
  params,
}: PageProps<"/o/[orgSlug]/traceability/mock-recalls">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "traceability.view")) notFound();
  const [t, locale, format, drills] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    listMockRecalls(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("mockRecalls.title")} description={t("mockRecalls.hint")} />
      <div className="space-y-4">
        <p className="text-muted text-sm">
          <Link href={`/o/${orgSlug}/traceability`} className="text-primary hover:underline">
            {t("mockRecalls.startHint")}
          </Link>
        </p>
        {drills.length === 0 ? (
          <EmptyState title={t("mockRecalls.empty")} />
        ) : (
          <Table label={t("mockRecalls.title")}>
            <thead>
              <tr>
                <Th>{t("mockRecalls.number")}</Th>
                <Th>{t("mockRecalls.lot")}</Th>
                <Th>{t("mockRecalls.started")}</Th>
                <Th>{t("mockRecalls.elapsed")}</Th>
                <Th>{t("mockRecalls.accounted")}</Th>
                <Th>{t("mockRecalls.result")}</Th>
              </tr>
            </thead>
            <tbody>
              {drills.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/traceability/mock-recalls/${d.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {d.number}
                    </Link>
                    <span className="ltr-value text-muted block font-mono text-xs">
                      {d.branch.code}
                    </span>
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{d.lot.lotCode}</span>
                    <span className="text-muted block text-xs">
                      {d.lot.product.sku} — {productName(d.lot.product, locale)}
                    </span>
                  </Td>
                  <Td>
                    {format.dateTime(d.startedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: ctx.timeZone,
                    })}
                  </Td>
                  <Td>
                    {d.elapsedSeconds === null
                      ? "—"
                      : t("mockRecalls.hoursMinutes", splitElapsed(d.elapsedSeconds))}
                    {d.targetMinutes ? (
                      <span className="text-muted block text-xs">
                        {d.withinTarget === false
                          ? t("mockRecalls.targetMissed")
                          : `${t("mockRecalls.target")}: ${d.targetMinutes}`}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <span className="ltr-value tabular-nums">
                      {d.accountedPercent ? `${d.accountedPercent.toString()} %` : "—"}
                    </span>
                  </Td>
                  <Td>
                    <MockRecallBadge
                      status={d.status}
                      passed={d.status === "COMPLETED" ? d.nonConformance === null : null}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
