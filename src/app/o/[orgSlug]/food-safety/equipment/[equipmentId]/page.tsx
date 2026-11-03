import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AttachmentsCard } from "@/components/attachments/attachments-card";
import { DueBadge, EquipmentStatusBadge } from "@/components/foodsafety/equipment-badges";
import { CalibrationForm, MaintenanceForm } from "@/components/foodsafety/equipment-forms";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { ReasonForm } from "@/components/procurement/forms";
import {
  Alert,
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
import { getEquipment } from "@/modules/foodsafety/equipment";
import { businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  calibrateAction,
  maintainAction,
  outOfServiceAction,
  retireAction,
  returnToServiceAction,
} from "../actions";

export default async function EquipmentDetailPage({
  params,
}: PageProps<"/o/[orgSlug]/food-safety/equipment/[equipmentId]">) {
  const { orgSlug, equipmentId } = await params;
  if (!isUuid(equipmentId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const view = await notFoundOnAppError(getEquipment(ctx, equipmentId));
  const { equipment: e, can } = view;
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const day = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" }) : "—";
  const today = businessDate(ctx.timeZone);
  return (
    <>
      <PageHeader
        title={`${e.code} — ${e.name}`}
        description={`${e.branch.code} — ${e.branch.name} · ${t(`equipment.types.${e.type}`)}`}
        actions={<EquipmentStatusBadge status={e.status} />}
      />
      <div className="space-y-6">
        {e.status !== "ACTIVE" && e.statusReason ? (
          <Alert tone={e.status === "RETIRED" ? "info" : "error"}>{e.statusReason}</Alert>
        ) : null}
        <Card>
          <DescriptionList
            items={[
              { label: t("equipment.serialNumber"), value: e.serialNumber ?? "—" },
              { label: t("equipment.location"), value: e.location ?? "—" },
              {
                label: t("equipment.checkpoint"),
                value: e.checkpoint ? `${e.checkpoint.code} — ${e.checkpoint.name}` : "—",
              },
              {
                label: t("equipment.calibrationDue"),
                value: <DueBadge state={view.calibrationState} date={view.calibrationDue} />,
              },
              {
                label: t("equipment.maintenanceDue"),
                value: <DueBadge state={view.maintenanceState} date={view.maintenanceDue} />,
              },
              {
                label: t("equipment.intervals"),
                value: t("equipment.intervalsValue", {
                  cal: e.calibrationIntervalDays ?? "—",
                  maint: e.maintenanceIntervalDays ?? "—",
                }),
              },
            ]}
          />
          <div className="mt-4 flex flex-wrap items-start gap-4">
            {can.returnToService ? (
              <ConfirmActionButton
                action={returnToServiceAction.bind(null, orgSlug, e.id)}
                label={t("equipment.returnToService")}
                variant="secondary"
              />
            ) : null}
            {can.outOfService ? (
              <div className="w-full max-w-sm">
                <ReasonForm
                  action={outOfServiceAction.bind(null, orgSlug, e.id)}
                  label={t("equipment.outOfServiceReason")}
                  submitLabel={t("equipment.outOfService")}
                />
              </div>
            ) : null}
            {can.manage ? (
              <div className="w-full max-w-sm">
                <ReasonForm
                  action={retireAction.bind(null, orgSlug, e.id)}
                  label={t("equipment.retireReason")}
                  submitLabel={t("equipment.retire")}
                  variant="danger"
                />
              </div>
            ) : null}
          </div>
        </Card>

        <Card title={t("equipment.calibrations")}>
          {e.calibrations.length === 0 ? (
            <EmptyState title={t("equipment.noCalibrations")} />
          ) : (
            <Table label={t("equipment.calibrations")}>
              <thead>
                <tr>
                  <Th>{t("equipment.performedOn")}</Th>
                  <Th>{t("equipment.performedBy")}</Th>
                  <Th>{t("equipment.measurement")}</Th>
                  <Th>{t("equipment.result")}</Th>
                  <Th>{t("equipment.nextDue")}</Th>
                </tr>
              </thead>
              <tbody>
                {e.calibrations.map((c) => (
                  <tr key={c.id}>
                    <Td className="whitespace-nowrap">{day(c.performedOn)}</Td>
                    <Td>
                      {c.performedBy}
                      {c.method ? (
                        <span className="text-muted block text-xs">{c.method}</span>
                      ) : null}
                      {c.certificateNo ? (
                        <span className="ltr-value text-muted block font-mono text-xs">
                          {c.certificateNo}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="tabular-nums">
                      {c.referenceValue !== null ? (
                        <span className="ltr-value whitespace-nowrap">
                          {c.readingValue?.toString()} / {c.referenceValue.toString()} ±
                          {c.tolerance?.toString()} {c.unit ?? ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      <Badge tone={c.result === "PASS" ? "success" : "danger"}>
                        {t(`equipment.results.${c.result}`)}
                      </Badge>
                      {c.nonConformance ? (
                        <Link
                          href={`/o/${orgSlug}/food-safety/non-conformances/${c.nonConformance.id}`}
                          className="ltr-value text-primary block font-mono text-xs hover:underline"
                        >
                          {c.nonConformance.number}
                        </Link>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">{day(c.nextDueOn)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {e.calibrations[0] ? (
            <div className="mt-4">
              <AttachmentsCard
                ctx={ctx}
                orgSlug={orgSlug}
                entityType="CALIBRATION"
                entityId={e.calibrations[0].id}
              />
            </div>
          ) : null}
          {can.record ? (
            <div className="mt-4">
              <CalibrationForm action={calibrateAction.bind(null, orgSlug, e.id)} today={today} />
            </div>
          ) : null}
        </Card>

        <Card title={t("equipment.maintenanceTitle")}>
          {e.maintenance.length === 0 ? (
            <EmptyState title={t("equipment.noMaintenance")} />
          ) : (
            <ul className="divide-border divide-y text-sm">
              {e.maintenance.map((m) => (
                <li key={m.id} className="py-2">
                  <span className="font-medium">{t(`equipment.maintenanceTypes.${m.type}`)}</span> ·{" "}
                  {day(m.performedOn)} · {m.performedBy}
                  <span className="block">{m.description}</span>
                  {m.nextDueOn ? (
                    <span className="text-muted text-xs">
                      {t("equipment.nextDue")}: {day(m.nextDueOn)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {can.record ? (
            <div className="mt-4">
              <MaintenanceForm action={maintainAction.bind(null, orgSlug, e.id)} today={today} />
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
