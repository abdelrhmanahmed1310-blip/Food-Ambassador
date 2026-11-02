import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CopyField } from "@/components/forms/fields";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { DeviceForm, GeofenceForm, TerminalForm } from "@/components/hr/attendance-forms";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { attendanceSetup } from "@/modules/hr/attendance";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getEnv } from "@/server/env";
import {
  createDeviceAction,
  createTerminalAction,
  removeGeofenceAction,
  setGeofenceAction,
  setTerminalActiveAction,
} from "../actions";

/** Branch tablets, phone clock-in locations and devices (ADR-080). */
export default async function AttendanceSetupPage({
  params,
}: PageProps<"/o/[orgSlug]/hr/attendance/setup">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "hr.manage")) notFound();
  const [t, setup] = await Promise.all([getTranslations("attendance"), attendanceSetup(ctx)]);
  const appUrl = getEnv().APP_URL;
  const branches = setup.branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }));
  return (
    <>
      <PageHeader title={t("setupTitle")} description={t("setupIntro")} />
      <div className="space-y-6">
        <Card title={t("terminals")}>
          <p className="text-muted mb-4 text-sm">{t("terminalsIntro")}</p>
          <ul className="mb-4 space-y-3">
            {setup.branches.flatMap((b) =>
              b.attendanceTerminals.map((term) => (
                <li
                  key={term.id}
                  className="border-border space-y-2 rounded-lg border p-3"
                  data-testid="terminal"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {term.name} · <span className="ltr-value">{b.code}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={term.active ? "success" : "muted"}>
                        {term.active ? t("active") : t("inactive")}
                      </Badge>
                      <ConfirmActionButton
                        action={setTerminalActiveAction.bind(null, orgSlug, term.id, !term.active)}
                        label={term.active ? t("deactivate") : t("activate")}
                        variant={term.active ? "danger" : "secondary"}
                      />
                    </span>
                  </div>
                  {term.active ? (
                    <CopyField
                      value={`${appUrl}/clock/${term.publicToken}`}
                      label={t("terminalLink")}
                      copyLabel={t("copy")}
                      copiedLabel={t("copied")}
                    />
                  ) : null}
                </li>
              )),
            )}
          </ul>
          <TerminalForm action={createTerminalAction.bind(null, orgSlug)} branches={branches} />
        </Card>

        <Card title={t("phoneClockIn")}>
          <p className="text-muted mb-4 text-sm">{t("phoneIntro")}</p>
          <div className="space-y-4">
            {setup.branches.map((b) => (
              <div
                key={b.id}
                className="border-border space-y-3 rounded-lg border p-3"
                data-testid={`geofence-${b.code}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    <span className="ltr-value">{b.code}</span> — {b.name}
                  </span>
                  {b.geofence ? (
                    <span className="flex items-center gap-2">
                      <Badge tone="success">
                        {t("withinRadius", { meters: b.geofence.radiusMeters })}
                      </Badge>
                      <ConfirmActionButton
                        action={removeGeofenceAction.bind(null, orgSlug, b.id)}
                        label={t("removeLocation")}
                      />
                    </span>
                  ) : (
                    <Badge tone="muted">{t("anywhere")}</Badge>
                  )}
                </div>
                <GeofenceForm
                  action={setGeofenceAction.bind(null, orgSlug, b.id)}
                  defaults={
                    b.geofence
                      ? {
                          latitude: b.geofence.latitude.toString(),
                          longitude: b.geofence.longitude.toString(),
                          radiusMeters: String(b.geofence.radiusMeters),
                        }
                      : undefined
                  }
                />
              </div>
            ))}
          </div>
        </Card>

        <Card title={t("devices")}>
          <p className="text-muted mb-4 text-sm">{t("devicesIntro")}</p>
          {setup.devices.length > 0 ? (
            <ul className="mb-4 space-y-2 text-sm">
              {setup.devices.map((d) => (
                <li
                  key={d.id}
                  className="border-border flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                >
                  <span className="font-medium">{d.name}</span>
                  <span className="ltr-value text-muted font-mono text-xs">
                    /api/integrations/inbound/{d.publicId} · {d.secretHint}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <DeviceForm action={createDeviceAction.bind(null, orgSlug)} branches={branches} />
        </Card>
      </div>
    </>
  );
}
