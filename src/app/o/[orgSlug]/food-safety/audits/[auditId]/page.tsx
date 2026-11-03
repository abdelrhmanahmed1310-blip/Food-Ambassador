import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { CompleteAuditForm, FindingForm } from "@/components/foodsafety/quality-forms";
import { ReasonForm } from "@/components/procurement/forms";
import {
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getAudit } from "@/modules/foodsafety/quality";
import { businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { addFindingAction, cancelAuditAction, completeAuditAction } from "../../quality-actions";

const SEV_TONE = {
  OBSERVATION: "neutral",
  MINOR: "warning",
  MAJOR: "danger",
  CRITICAL: "danger",
} as const;

export default async function AuditPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/audits/[auditId]">) {
  const { orgSlug, auditId } = await params;
  if (!isUuid(auditId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const { audit: a, counts, can } = await notFoundOnAppError(getAudit(ctx, auditId));
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const day = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" }) : "—";
  return (
    <>
      <PageHeader
        title={`${a.number} — ${t(`audits.types.${a.type}`)}`}
        description={`${a.branch.code} — ${a.branch.name} · ${a.auditor}`}
        actions={
          <Badge
            tone={
              a.status === "COMPLETED" ? "success" : a.status === "PLANNED" ? "warning" : "muted"
            }
          >
            {t(`audits.statuses.${a.status}`)}
          </Badge>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("audits.scope"), value: a.scope },
              { label: t("audits.plannedOn"), value: day(a.plannedOn) },
              { label: t("audits.conductedOn"), value: day(a.conductedOn) },
              { label: t("audits.result"), value: a.result ?? "—" },
              { label: t("audits.summary"), value: a.summary ?? "—" },
              ...(a.cancelReason
                ? [{ label: t("audits.cancelReason"), value: a.cancelReason }]
                : []),
              {
                label: t("audits.findings"),
                value: counts
                  .map((c) => `${c.count} ${t(`audits.severities.${c.severity}`)}`)
                  .join(" · "),
              },
            ]}
          />
        </Card>
        <Card title={t("audits.findings")}>
          {a.findings.length === 0 ? (
            <EmptyState title={t("audits.noFindings")} />
          ) : (
            <Table label={t("audits.findings")}>
              <thead>
                <tr>
                  <Th>{t("audits.severity")}</Th>
                  <Th>{t("audits.finding")}</Th>
                  <Th>{t("audits.nonConformance")}</Th>
                </tr>
              </thead>
              <tbody>
                {a.findings.map((f) => (
                  <tr key={f.id}>
                    <Td>
                      <Badge tone={SEV_TONE[f.severity]}>
                        {t(`audits.severities.${f.severity}`)}
                      </Badge>
                    </Td>
                    <Td>
                      {f.description}
                      {f.reference ? (
                        <span className="text-muted block text-xs">{f.reference}</span>
                      ) : null}
                    </Td>
                    <Td>
                      {f.nonConformance ? (
                        <Link
                          href={`/o/${orgSlug}/food-safety/non-conformances/${f.nonConformance.id}`}
                          className="ltr-value text-primary font-mono text-xs hover:underline"
                        >
                          {f.nonConformance.number}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {can.edit ? (
            <div className="mt-4">
              <FindingForm action={addFindingAction.bind(null, orgSlug, a.id)} />
            </div>
          ) : null}
        </Card>
        {can.edit ? (
          <Card title={t("audits.completeTitle")}>
            <CompleteAuditForm
              action={completeAuditAction.bind(null, orgSlug, a.id)}
              today={businessDate(ctx.timeZone)}
            />
            {a.findings.length === 0 ? (
              <div className="mt-6 max-w-md">
                <ReasonForm
                  action={cancelAuditAction.bind(null, orgSlug, a.id)}
                  label={t("audits.cancelReason")}
                  submitLabel={t("audits.cancel")}
                  variant="danger"
                />
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
