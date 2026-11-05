import { getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { ExternalRecordForm, ReasonForm } from "@/components/learning/forms";
import { Badge, Card, Table, Td, Th } from "@/components/ui/primitives";
import type { employeeTraining } from "@/modules/learning/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { COMPLIANCE_TONE } from "@/app/o/[orgSlug]/hr/learning/status";
import { addRecordAction, voidRecordAction } from "@/app/o/[orgSlug]/hr/learning/actions";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");

/** An employee's required courses and training records (ADR-125). */
export async function TrainingSection({
  ctx,
  data,
  locale,
  orgSlug,
  employeeId,
  manage,
}: {
  ctx: TenantContext;
  data: Awaited<ReturnType<typeof employeeTraining>>;
  locale: string;
  orgSlug: string;
  employeeId?: string;
  manage: boolean;
}) {
  const t = await getTranslations("learning");
  const name = (c: { name: string; nameAr: string | null }) =>
    (locale === "ar" && c.nameAr) || c.name;
  return (
    <div className="space-y-4" data-testid="employee-training">
      {data.required.length === 0 ? (
        <p className="text-muted text-sm">{t("nothingRequired")}</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.required.map((c) => {
            const course = data.courseNames.get(c.courseId);
            return (
              <li
                key={c.courseId}
                className="border-border flex items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span>
                  <span className="ltr-value font-mono text-xs">{course?.code}</span>{" "}
                  {course ? name(course) : ""}
                  <span className="ltr-value text-muted block text-xs">
                    {c.expiresOn
                      ? t("expiresOn", { date: c.expiresOn })
                      : c.dueOn
                        ? t("dueOn", { date: c.dueOn })
                        : t("noExpiry")}
                  </span>
                </span>
                <Badge tone={COMPLIANCE_TONE[c.status]}>{t(`statuses.${c.status}`)}</Badge>
              </li>
            );
          })}
        </ul>
      )}
      {data.records.length > 0 ? (
        <Table label={t("records")}>
          <thead>
            <tr>
              <Th>{t("course")}</Th>
              <Th>{t("completedOn")}</Th>
              <Th>{t("expires")}</Th>
              <Th>{t("provider")}</Th>
              {manage ? <Th>{t("actions")}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {data.records.map((r) => (
              <tr key={r.id} className={r.voidedAt ? "opacity-60" : ""}>
                <Td>
                  {r.course.code} — {name(r.course)}
                  {r.voidedAt ? (
                    <span className="text-danger block text-xs">
                      {t("voided", { reason: r.voidReason ?? "" })}
                    </span>
                  ) : null}
                  {r.certificateNumber ? (
                    <span className="ltr-value text-muted block text-xs">
                      {r.certificateNumber}
                    </span>
                  ) : null}
                </Td>
                <Td className="ltr-value">{day(r.completedOn)}</Td>
                <Td className="ltr-value">{day(r.expiresOn)}</Td>
                <Td>{r.provider ?? "—"}</Td>
                {manage ? (
                  <Td>
                    {r.voidedAt ? null : (
                      <ReasonForm
                        action={voidRecordAction.bind(null, orgSlug, r.id)}
                        label={t("void")}
                      />
                    )}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-muted text-sm">{t("noRecords")}</p>
      )}
      {data.records
        .filter((r) => !r.voidedAt)
        .slice(0, 5)
        .map((r) => (
          <details key={r.id} className="text-sm">
            <summary className="text-primary cursor-pointer">
              {t("certificateFor", { course: r.course.code, date: day(r.completedOn) })}
            </summary>
            <div className="mt-2">
              <AttachmentsCard
                ctx={ctx}
                orgSlug={orgSlug}
                entityType="TRAINING_RECORD"
                entityId={r.id}
              />
            </div>
          </details>
        ))}
      {manage && employeeId ? (
        <Card title={t("addRecord")}>
          <ExternalRecordForm
            action={addRecordAction.bind(null, orgSlug, employeeId)}
            courses={data.courses.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))}
          />
        </Card>
      ) : null}
    </div>
  );
}
