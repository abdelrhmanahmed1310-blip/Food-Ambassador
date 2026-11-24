import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { TwoFactorSetup } from "@/components/two-factor-forms";
import { listMyConnectedApps } from "@/modules/oauth/service";
import { requireUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import {
  confirmTwoFactorAction,
  disableTwoFactorAction,
  enableTwoFactorAction,
  revokeMyConnectedAppAction,
} from "./actions";

export const dynamic = "force-dynamic";

/** The signed-in user's own security: two-factor sign-in (ADR-073). */
export default async function SecurityPage() {
  const user = await requireUser("/account/security");
  const t = await getTranslations("auth");
  const apps = await listMyConnectedApps(user.id);
  const row = await getDb().user.findUniqueOrThrow({
    where: { id: user.id },
    select: { twoFactorEnabled: true },
  });
  return (
    <main className="mx-auto w-full max-w-xl space-y-4 p-6">
      <Link href="/" className="text-primary text-sm hover:underline">
        ← {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("securityTitle")}</h1>
      <p className="text-muted text-sm">{t("securityIntro")}</p>
      <section className="border-border bg-surface space-y-3 rounded-lg border p-4">
        <h2 className="font-semibold">{t("twoFactorTitle")}</h2>
        <p className="text-sm" data-testid="two-factor-status">
          {row.twoFactorEnabled ? t("twoFactorIsOn") : t("twoFactorIsOff")}
        </p>
        <TwoFactorSetup
          enabled={row.twoFactorEnabled}
          enable={enableTwoFactorAction}
          confirm={confirmTwoFactorAction}
          disable={disableTwoFactorAction}
        />
      </section>
      <section className="border-border bg-surface space-y-3 rounded-lg border p-4">
        <h2 className="font-semibold">{t("connectedAppsTitle")}</h2>
        <p className="text-muted text-sm">{t("connectedAppsIntro")}</p>
        {apps.length === 0 ? (
          <p className="text-sm">{t("noConnectedApps")}</p>
        ) : (
          <ul className="divide-border divide-y text-sm">
            {apps.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                data-testid="my-connected-app"
              >
                <span>
                  <span className="font-medium">{a.client.clientName}</span> · {a.organization.name}{" "}
                  · <span className="ltr-value text-xs">{a.scopes.join(", ")}</span>
                </span>
                <ConfirmActionButton
                  action={revokeMyConnectedAppAction.bind(null, a.organization.slug, a.id)}
                  label={t("disconnectApp")}
                  confirmMessage={t("disconnectAppConfirm")}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
