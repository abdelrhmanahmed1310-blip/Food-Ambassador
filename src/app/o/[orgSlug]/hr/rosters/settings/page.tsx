import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { RosterSettingsForm, ShiftTemplateForm } from "@/components/rosters/forms";
import { Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { accessibleScope } from "@/modules/access/authorize";
import { getRosterSettings, listShiftTemplates } from "@/modules/rosters/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import {
  archiveShiftTemplateAction,
  createShiftTemplateAction,
  saveRosterSettingsAction,
} from "../actions";

/** Roster settings and shift templates, as the organization enters them (ADR-128). */
export default async function RosterSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/rosters/settings">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!accessibleScope(ctx.grants, "hr.manage").all) notFound();
  const [t, s, templates] = await Promise.all([
    getTranslations("rosters"),
    getRosterSettings(ctx),
    listShiftTemplates(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("settingsTitle")} description={t("settingsHint")} />
      <div className="space-y-6">
        <Card title={t("comparing")}>
          <RosterSettingsForm
            action={saveRosterSettingsAction.bind(null, orgSlug)}
            values={{
              graceMinutes: String(s?.graceMinutes ?? 0),
              overtimeMinimumMinutes: String(s?.overtimeMinimumMinutes ?? 0),
              standardDailyHours: s?.standardDailyHours?.toString() ?? "",
              overtimeMultiplier: s?.overtimeMultiplier?.toString() ?? "",
              overtimeBase: s?.overtimeBase ?? "",
            }}
          />
        </Card>
        <Card title={t("templates")}>
          {templates.length ? (
            <Table label={t("templates")}>
              <thead>
                <tr>
                  <Th>{t("code")}</Th>
                  <Th>{t("name")}</Th>
                  <Th>{t("times")}</Th>
                  <Th>{t("breakMinutes")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {templates.map((x) => (
                  <tr key={x.id}>
                    <Td>{x.code}</Td>
                    <Td>{x.name}</Td>
                    <Td className="tabular-nums">
                      {x.startTime}–{x.endTime}
                      {x.endTime <= x.startTime ? ` (${t("nextDay")})` : ""}
                    </Td>
                    <Td className="tabular-nums">{x.breakMinutes}</Td>
                    <Td>
                      <ConfirmActionButton
                        action={archiveShiftTemplateAction.bind(null, orgSlug, x.id)}
                        label={t("archive")}
                        variant="secondary"
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-muted text-sm">{t("noTemplates")}</p>
          )}
          <div className="mt-4">
            <ShiftTemplateForm action={createShiftTemplateAction.bind(null, orgSlug)} />
          </div>
        </Card>
      </div>
    </>
  );
}
