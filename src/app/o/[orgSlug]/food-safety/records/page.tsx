import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { SpecBadge } from "@/components/foodsafety/badges";
import { RecordForm } from "@/components/foodsafety/forms";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { branchOptions, listCheckpoints, listRecords } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { addRecordAction } from "../actions";

export default async function RecordsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/food-safety/records">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const outOfSpec = sp.out === "1";
  const canRecord = holdsAnyGrant(ctx.grants, "foodsafety.record");
  const [t, format, records, checkpoints, branches] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listRecords(ctx, { outOfSpec }),
    canRecord ? listCheckpoints(ctx) : Promise.resolve([]),
    canRecord ? branchOptions(ctx, "foodsafety.record") : Promise.resolve([]),
  ]);
  const limits = (min: { toFixed(): string } | null, max: { toFixed(): string } | null) =>
    min && max
      ? `${min.toFixed()} – ${max.toFixed()} °C`
      : min
        ? `≥ ${min.toFixed()} °C`
        : max
          ? `≤ ${max.toFixed()} °C`
          : "";
  return (
    <>
      <PageHeader title={t("foodSafety.recordsTitle")} description={t("foodSafety.recordsHint")} />
      <div className="space-y-6">
        {canRecord ? (
          <Card title={t("foodSafety.newRecord")}>
            <RecordForm
              action={addRecordAction.bind(null, orgSlug)}
              checkpoints={checkpoints.map((c) => ({
                value: c.id,
                label: `${c.branch.code} · ${c.code} — ${c.name} (${limits(c.minCelsius, c.maxCelsius)})`,
              }))}
              branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            />
          </Card>
        ) : null}
        <nav className="flex gap-3 text-sm">
          <Link
            href={`/o/${orgSlug}/food-safety/records`}
            className={!outOfSpec ? "font-semibold" : "text-primary hover:underline"}
          >
            {t("common.all")}
          </Link>
          <Link
            href={`/o/${orgSlug}/food-safety/records?out=1`}
            className={outOfSpec ? "font-semibold" : "text-primary hover:underline"}
          >
            {t("foodSafety.outOfSpecOnly")}
          </Link>
        </nav>
        {records.length === 0 ? (
          <EmptyState title={t("foodSafety.noRecords")} />
        ) : (
          <Table label={t("foodSafety.recordsTitle")}>
            <thead>
              <tr>
                <Th>{t("common.date")}</Th>
                <Th>{t("foodSafety.branch")}</Th>
                <Th>{t("foodSafety.recordType")}</Th>
                <Th>{t("foodSafety.result")}</Th>
                <Th>{t("foodSafety.limits")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("common.note")}</Th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} data-testid="safety-record">
                  <Td className="whitespace-nowrap">
                    {format.dateTime(r.recordedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: ctx.timeZone,
                    })}
                    <span className="text-muted block text-xs">
                      <bdi>{r.recordedBy ?? "—"}</bdi>
                    </span>
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{r.branch.code}</span>
                  </Td>
                  <Td>
                    {t(`foodSafety.recordTypes.${r.type}`)}
                    {r.checkpoint ? (
                      <span className="text-muted block text-xs">
                        {r.checkpoint.code} — {r.checkpoint.name}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">
                    {r.valueCelsius !== null ? (
                      <span className="ltr-value">{r.valueCelsius.toFixed()} °C</span>
                    ) : r.passed ? (
                      t("foodSafety.pass")
                    ) : (
                      t("foodSafety.fail")
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {limits(r.minCelsius, r.maxCelsius) || "—"}
                    </span>
                  </Td>
                  <Td>
                    <SpecBadge inSpec={r.inSpec} />
                    {r.nonConformance ? (
                      <Link
                        href={`/o/${orgSlug}/food-safety/non-conformances/${r.nonConformance.id}`}
                        className="ltr-value text-primary mt-1 block font-mono text-xs hover:underline"
                      >
                        {r.nonConformance.number}
                      </Link>
                    ) : null}
                  </Td>
                  <Td>
                    {r.note ?? ""}
                    {r.correctiveNote ? (
                      <span className="text-muted block text-xs">{r.correctiveNote}</span>
                    ) : null}
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
